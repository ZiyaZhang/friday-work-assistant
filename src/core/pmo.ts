/**
 * PMO 看板：每个群空间把自己的工作项单向镜像到独立的多维表格。
 *
 * 边界：
 * - 工作项状态在 Friday 的库里；建行后保留表内人工编辑，只更新 Friday 的观察列。
 * - 只同步绑定群空间的事项；可读权限不等于把其他空间内容导出到表格的授权。
 * - 记住 todo → record 的映射和内容指纹，没变的行不重写，避免把表格的"最后修改时间"刷成一片。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { FIELD_TYPE, type Bitable, type BitableField, type BitableRecord } from '../feishu/bitable.js'
import { KIND_LABEL, STATUS_LABEL, type Todo, type Todos } from './todos.js'
import { spaceScope, type Space } from './space.js'
import { githubRefKey, githubRefs, githubStateLabel, readGitHubStates, type GitHubItemState, type GitHubRef } from './todo-completion-evidence.js'
import { presentTodoOrigin } from './todo-origin-presentation.js'

export const PMO_TABLE = '工作项'

/** 风险标签。空字符串 = 没有风险，人也可以手动清成空。 */
/**
 * 风险标签。每一个都必须是**看得见的事实**，不是对工作状态的判断。
 *
 * 原来叫「逾期未动」「无人认领」「久无进展」——三个都在替人下结论：
 * 没更新状态不等于没进展（人可能一直在做，只是没回来改那一列），
 * 没有 assignee 也不等于没人认领（有人在评论里说过"我来"是看不出来的）。
 * 表格是给人看的，一个越权的判断会让不了解情况的人据此追责。
 */
export const RISK_LABELS = ['已过截止', '没有负责人', '状态久未更新'] as const

const DAY = 24 * 3600_000

/** 表结构。加字段就往后追加，ensureFields 会在已有表上补出来。 */
export const PMO_FIELDS: BitableField[] = [
  { field_name: '事项', type: FIELD_TYPE.text },
  { field_name: '编号', type: FIELD_TYPE.number, property: { formatter: '0' } },
  { field_name: '类型', type: FIELD_TYPE.singleSelect, property: { options: Object.values(KIND_LABEL).map((name) => ({ name })) } },
  { field_name: '状态', type: FIELD_TYPE.singleSelect, property: { options: Object.values(STATUS_LABEL).map((name) => ({ name })) } },
  { field_name: '负责人', type: FIELD_TYPE.text },
  { field_name: '截止时间', type: FIELD_TYPE.date, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
  { field_name: '空间', type: FIELD_TYPE.text },
  { field_name: '已确认', type: FIELD_TYPE.checkbox },
  { field_name: '状态说明', type: FIELD_TYPE.text },
  { field_name: '更新时间', type: FIELD_TYPE.date, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
  { field_name: '作用域', type: FIELD_TYPE.text },
  // 建行后其余列归人；Friday 读取这些事实，只更新自己的列（观察、风险、关联）。
  { field_name: 'Friday 观察', type: FIELD_TYPE.text },
  { field_name: '风险', type: FIELD_TYPE.singleSelect, property: { options: RISK_LABELS.map((name) => ({ name })) } },
  // 待办的出处链接，以及待办里 Issue / PR 链接的只读状态。
  { field_name: '关联', type: FIELD_TYPE.text },
]

const SCHEMA = `
-- 旧 pmo_records 缺少目标表标识，保留作历史记录，不能安全地自动迁移。
CREATE TABLE IF NOT EXISTS pmo_base_owners (
  app_token TEXT PRIMARY KEY,
  space_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pmo_projection_records (
  app_token TEXT NOT NULL,
  table_id TEXT NOT NULL,
  todo_id INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (app_token, table_id, todo_id)
);
CREATE TABLE IF NOT EXISTS pmo_projection_writes (
  app_token TEXT NOT NULL,
  table_id TEXT NOT NULL,
  todo_id INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expected_fields TEXT NOT NULL,
  PRIMARY KEY (app_token, table_id, todo_id)
);
`

/** An update intent for Friday's own columns. `previous` holds those columns as read just before the first
 * send; it separates “not observed yet” from “a person changed them”. Legacy intents have no previous. */
interface PendingProjection { recordId: string; fingerprint: string; fields: Record<string, unknown>; previous?: Record<string, unknown> | null; attempts?: number; updatedAt?: number | null }
/** Total sends of one unobserved update, and the wait before resending the same values. */
export const PMO_MAX_ATTEMPTS = 3
export const PMO_RETRY_DELAY_MS = 60_000
const OWN_COLUMNS = ['Friday 观察', '风险', '关联'] as const
/** 同步前补列只补 Friday 自有列：人维护的列被删了，不替人加回来。 */
export const PMO_OWN_FIELDS: BitableField[] = PMO_FIELDS.filter(field => (OWN_COLUMNS as readonly string[]).includes(field.field_name))

/** 「关联」列要用的只读依赖。整个不给：这一轮不写「关联」列（比如表里这一列还没建好），指纹里这一段沿用上次的。 */
export interface PmoLinks {
  /** 读一个 Issue / PR 的当前状态；没有配置 GitHub 时不给，链接一律写“未读到”。 */
  readGitHub?: (ref: GitHubRef) => Promise<GitHubItemState>
}

/**
 * 同步前核对 Friday 自有列：缺的补上（只补自有列；旧表没有「关联」列）。
 * 表里已有同名但不是文本的「关联」列，是人建的：不接管。返回这一轮能不能写「关联」列；读不到列、补不上时抛错，由调用方按不能写处理。
 */
export async function preparePmoColumns(bitable: Pick<Bitable, 'listFields' | 'ensureFields'>, binding: PmoBinding, assertCurrent: () => void): Promise<boolean> {
  assertCurrent()
  const have = new Map((await bitable.listFields(binding.appToken, binding.tableId)).map(field => [field.fieldName, field.type]))
  assertCurrent()
  if (PMO_OWN_FIELDS.some(field => !have.has(field.field_name))) await bitable.ensureFields(binding.appToken, binding.tableId, PMO_OWN_FIELDS)
  const link = have.get('关联')
  return link === undefined || link === FIELD_TYPE.text
}

export interface PmoBinding {
  spaceId: string
  /** 授权自动同步的配置者；每次自动同步重新核验 configure 权限。 */
  boundBy: string
  appToken: string
  tableId: string
  url: string
  /** 每次绑定生成新版本，防止停用后重绑使旧任务重新获得写权限。 */
  version?: string
}

export class PmoStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
    // Nullable/defaulted additions: existing intents keep their values; nothing is back-filled.
    const columns = new Set((db.prepare('PRAGMA table_info(pmo_projection_writes)').all() as { name: string }[]).map(row => row.name))
    if (!columns.has('previous_fields')) db.exec('ALTER TABLE pmo_projection_writes ADD COLUMN previous_fields TEXT')
    if (!columns.has('attempts')) db.exec('ALTER TABLE pmo_projection_writes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1')
    if (!columns.has('updated_at')) db.exec('ALTER TABLE pmo_projection_writes ADD COLUMN updated_at INTEGER')
  }

  /** 授权作用于整个 base；不同群不能共用。重绑后保留旧归属，旧行仍在。 */
  claim(binding: PmoBinding): boolean {
    this.db.prepare('INSERT OR IGNORE INTO pmo_base_owners (app_token, space_id) VALUES (?, ?)').run(binding.appToken, binding.spaceId)
    return this.owns(binding)
  }

  owns(binding: PmoBinding): boolean {
    const r = this.db.prepare('SELECT space_id FROM pmo_base_owners WHERE app_token = ?').get(binding.appToken) as { space_id: string } | undefined
    return r?.space_id === binding.spaceId
  }

  get(binding: PmoBinding, todoId: number): { recordId: string; fingerprint: string } | undefined {
    const r = this.db.prepare('SELECT record_id, fingerprint FROM pmo_projection_records WHERE app_token = ? AND table_id = ? AND todo_id = ?').get(binding.appToken, binding.tableId, todoId) as { record_id?: string; fingerprint?: string } | undefined
    return r ? { recordId: String(r.record_id ?? ''), fingerprint: String(r.fingerprint) } : undefined
  }

  /** 空 record_id 是待核验的建行占位。发送前持久化，重启或回执丢失也不能再建一遍。 */
  reserveCreate(binding: PmoBinding, todoId: number, fingerprint: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO pmo_projection_records (app_token, table_id, todo_id, record_id, fingerprint, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(binding.appToken, binding.tableId, todoId, '', fingerprint, this.now()).changes) > 0
  }

  remember(binding: PmoBinding, todoId: number, recordId: string, fingerprint: string): void {
    this.db
      .prepare('INSERT INTO pmo_projection_records (app_token, table_id, todo_id, record_id, fingerprint, synced_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_token, table_id, todo_id) DO UPDATE SET record_id = excluded.record_id, fingerprint = excluded.fingerprint, synced_at = excluded.synced_at')
      .run(binding.appToken, binding.tableId, todoId, recordId, fingerprint, this.now())
  }

  pendingWrite(binding: PmoBinding, todoId: number): PendingProjection | undefined {
    const row = this.db.prepare('SELECT record_id, fingerprint, expected_fields, previous_fields, attempts, updated_at FROM pmo_projection_writes WHERE app_token = ? AND table_id = ? AND todo_id = ?')
      .get(binding.appToken, binding.tableId, todoId) as { record_id: string; fingerprint: string; expected_fields: string; previous_fields: string | null; attempts: number; updated_at: number | null } | undefined
    return row && { recordId: row.record_id, fingerprint: row.fingerprint, fields: JSON.parse(row.expected_fields) as Record<string, unknown>,
      previous: row.previous_fields ? JSON.parse(row.previous_fields) as Record<string, unknown> : null, attempts: Number(row.attempts ?? 1),
      updatedAt: row.updated_at == null ? null : Number(row.updated_at) }
  }

  /** 更新也先占位；未知回执只核验，不因重试覆盖人刚清掉的风险。 */
  reserveWrite(binding: PmoBinding, todoId: number, projection: PendingProjection): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO pmo_projection_writes (app_token, table_id, todo_id, record_id, fingerprint, expected_fields, previous_fields, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(binding.appToken, binding.tableId, todoId, projection.recordId, projection.fingerprint, JSON.stringify(projection.fields),
        projection.previous ? JSON.stringify(projection.previous) : null, this.now()).changes) > 0
  }

  /** Durable before resending the same values: a crash during the resend still counts it. */
  markAttempt(binding: PmoBinding, todoId: number, projection: PendingProjection): boolean {
    return Number(this.db.prepare('UPDATE pmo_projection_writes SET attempts = attempts + 1, updated_at = ? WHERE app_token = ? AND table_id = ? AND todo_id = ? AND fingerprint = ? AND expected_fields = ?')
      .run(this.now(), binding.appToken, binding.tableId, todoId, projection.fingerprint, JSON.stringify(projection.fields)).changes) > 0
  }

  /** The platform explicitly rejected the write, or a person changed Friday's columns: the intent ends. */
  dropWrite(binding: PmoBinding, todoId: number): void {
    this.db.prepare('DELETE FROM pmo_projection_writes WHERE app_token = ? AND table_id = ? AND todo_id = ?').run(binding.appToken, binding.tableId, todoId)
  }

  /** A person with configure permission decides an unresolved write should be planned again from current facts.
   * The caller checks that permission; the next sync computes and sends a new intent. */
  abandonPendingWrite(binding: PmoBinding, todoId: number): boolean {
    return Number(this.db.prepare('DELETE FROM pmo_projection_writes WHERE app_token = ? AND table_id = ? AND todo_id = ?').run(binding.appToken, binding.tableId, todoId).changes) > 0
  }

  confirmWrite(binding: PmoBinding, todoId: number, projection: PendingProjection): void {
    this.db.exec('SAVEPOINT pmo_confirm_write')
    try {
      const removed = this.db.prepare('DELETE FROM pmo_projection_writes WHERE app_token = ? AND table_id = ? AND todo_id = ? AND record_id = ? AND fingerprint = ? AND expected_fields = ?')
        .run(binding.appToken, binding.tableId, todoId, projection.recordId, projection.fingerprint, JSON.stringify(projection.fields))
      if (Number(removed.changes)) this.remember(binding, todoId, projection.recordId, projection.fingerprint)
      this.db.exec('RELEASE pmo_confirm_write')
    } catch (error) {
      this.db.exec('ROLLBACK TO pmo_confirm_write; RELEASE pmo_confirm_write')
      throw error
    }
  }

  forget(binding: PmoBinding, todoId: number): void {
    this.db.prepare('DELETE FROM pmo_projection_records WHERE app_token = ? AND table_id = ? AND todo_id = ?').run(binding.appToken, binding.tableId, todoId)
  }

  count(binding: PmoBinding): number {
    return Number((this.db.prepare(`SELECT COUNT(*) c FROM pmo_projection_records r
      WHERE r.app_token = ? AND r.table_id = ? AND r.record_id <> '' AND r.fingerprint NOT LIKE 'pending-create:%'
      AND NOT EXISTS (SELECT 1 FROM pmo_projection_writes w WHERE w.app_token = r.app_token AND w.table_id = r.table_id AND w.todo_id = r.todo_id)`)
      .get(binding.appToken, binding.tableId) as { c: number }).c)
  }
}

/** 一条工作项在表格里长什么样。 */
/**
 * 从事项自身的事实推出一句观察和一个风险标签。
 *
 * 只用**看得见的事实**：截止过了没有、有没有负责人、上一次变动是什么时候。
 * 不猜"他是不是忘了"，也不写"可能有风险"这种话——写出来的每一句都要能指着一个日期或一个空字段。
 *
 * 人可以把风险清成空。清掉之后不会再被提起来，除非**底下的事实变了**：
 * 写回表格的判断依据是 Friday 这一侧算出来的字段有没有变化，没变就不重写这一行。
 */
export function observe(t: Todo, now: number): { observation: string; risk: string } {
  // 已完成 / 已取消的不谈风险——它们已经结束了，再标一个"逾期"只会让人以为还欠着。
  if (t.status === 'done' || t.status === 'cancelled') return { observation: '', risk: '' }
  const lastMoved = t.statusAt ?? t.createdAt
  const idleDays = Math.floor((now - lastMoved) / DAY)
  const parts: string[] = []
  let risk = ''
  if (t.dueMs !== null && t.dueMs < now) {
    const overdueDays = Math.floor((now - t.dueMs) / DAY)
    parts.push(`截止是 ${fmtDay(t.dueMs)}，已经过去 ${overdueDays} 天`)
    risk = '已过截止'
  }
  if (!t.owner && !t.ownerOpenId) {
    parts.push('没有负责人')
    if (!risk) risk = '没有负责人'
  }
  if (idleDays >= 7) {
    parts.push(`状态上一次变动是 ${fmtDay(lastMoved)}，${idleDays} 天没变过（不代表没人在做）`)
    if (!risk) risk = '状态久未更新'
  }
  return { observation: parts.length ? `${parts.join('；')}。` : '', risk }
}

function fmtDay(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${fmtDay(ms)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}（北京时间）`
}

/**
 * 「关联」一格：待办的出处（和待办卡片、网页同一套呈现），以及待办标题 / 说明里 Issue、PR 链接的只读状态。
 * 每项一行，链接放在行尾；没有出处也没有链接就留空。没读到状态的（没配 GitHub、仓库不在允许范围、读取失败、
 * 超出本轮读取上限）一律写“未读到”，不写原因：原因每轮可能不同，写进去会让这一格来回改。
 */
export function associate(t: Todo, states: ReadonlyMap<string, GitHubItemState>): string {
  const lines: string[] = []
  const origin = presentTodoOrigin(t.origin)
  if (origin) {
    const items = origin.items.map(item => item.url ? `${item.label} ${item.url}` : item.label)
    lines.push(`出处：${[...items, ...(origin.notice ? [origin.notice] : [])].join(' · ')}`)
  }
  for (const ref of githubRefs([t.title, t.detail ?? ''])) {
    const state = states.get(githubRefKey(ref))
    const read = state?.status === 'read' ? state : undefined
    const label = githubStateLabel(read ? { kind: read.kind, state: read.state, merged: read.merged, stateReason: read.stateReason }
      : { kind: ref.kind, state: 'unavailable', merged: false, stateReason: null })
    lines.push(`${(read?.kind ?? ref.kind) === 'pull' ? 'PR' : 'Issue'} ${ref.owner}/${ref.repo}#${ref.number}：${label} ${ref.url}`)
  }
  return lines.join('\n')
}

/** 本轮要用的链接状态：没结束的事项先占读取名额；同一链接只读一次；超出上限或读失败的按未读到。 */
async function readLinkStates(items: readonly Todo[], read: PmoLinks['readGitHub']): Promise<Map<string, GitHubItemState>> {
  if (!read) return new Map()
  const ended = (t: Todo) => t.status === 'done' || t.status === 'cancelled'
  const ordered = [...items.filter(t => !ended(t)), ...items.filter(ended)]
  const reads = readGitHubStates(githubRefs(ordered.flatMap(t => [t.title, t.detail ?? ''])), read)
  return new Map(await Promise.all([...reads].map(async ([key, state]) => [key, await state] as const)))
}

/**
 * Friday 自己的列——**更新时只写这几列**。「关联」只在给了关联内容时带上（没给表示这一轮不写这一列）。
 *
 * 设计说的是按列定权威：事项 / 负责人 / 截止 / 状态归表格（人写的），Friday 只读；
 * 观察和风险归 Friday。但同步时写的是整行，于是人在表里把「已完成 / Bob」改好，
 * 下一轮又被改回「进行中 / Alice」——**Friday 把人的修改覆盖掉了**，
 * 而这恰恰是 PMO 最不该做的事：它存在的理由就是发现"状态是假的"，
 * 覆盖之后连真的那一版都没了。
 */
export function toOwnFields(t: Todo, now = Date.now(), association?: string): Record<string, unknown> {
  const { observation, risk } = observe(t, now)
  return { 'Friday 观察': observation, 风险: risk, ...(association === undefined ? {} : { 关联: association }) }
}

/** 建行时写全部：那一刻表里还没有任何人写的东西，没有可覆盖的。 */
export function toFields(t: Todo, spaceLabel: string, now = Date.now(), association?: string): Record<string, unknown> {
  return {
    ...toOwnFields(t, now, association),
    事项: t.title,
    编号: t.id,
    类型: KIND_LABEL[t.kind],
    状态: STATUS_LABEL[t.status],
    负责人: t.owner ?? '',
    截止时间: t.dueMs ?? undefined,
    空间: spaceLabel,
    已确认: t.confirmed,
    状态说明: t.statusNote ?? '',
    更新时间: t.statusAt ?? t.doneAt ?? t.createdAt,
    作用域: t.scope,
  }
}

/**
 * 决定"这一行要不要重写"的指纹。
 *
 * **故意不含「Friday 观察」那一列**：它里面有"N 天没动过"这种数字，每过一天就变，
 * 算进指纹就会变成每天重写一次——而人刚把「风险」清掉，第二天又被原样提起来，
 * 等于告诉他"清了也没用"。风险标签本身算在里面，所以**底下的事实真变了才会重提**。
 */
function fingerprint(fields: Record<string, unknown>): string {
  const { 'Friday 观察': _observation, ...rest } = fields
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16)
}

/** 「关联」一格为空时那一段指纹。v3 及更早的行 Friday 没写过这一列，按空算。 */
const EMPTY_LINK = fingerprint({ link: '' })

/** 记下的指纹里「关联」那一段（v4 第四段）；更早的格式没有这一段，按空算。 */
function linkPart(known: string | undefined): string {
  const [version, , , link] = (known ?? '').replace(/^pending-create:/, '').split(':')
  return version === 'v4' && link ? link : EMPTY_LINK
}

/**
 * 待核验的原因，每轮按原因分组计数：
 * - read_failed：读表格记录的接口报错（带平台错误码和原文）；read_incomplete：记录没有读全；
 * - row_not_found / row_duplicated：按编号和作用域在表里找不到这一行（或不是记下的那一行），或找到不止一行；
 * - fields_unreadable：这一行的状态、负责人或截止时间读不出来；
 * - create_unverified / write_unverified：建行或更新已发出，还没读回核对上（回执不明时带错误码）；
 * - in_flight：另一轮同步正占着这一行；todo_changed：同步期间本地事项被删除或移走；facts_changed：更新读到了，但期间事实又变了。
 */
export type PmoPendingReason = 'read_failed' | 'read_incomplete' | 'row_not_found' | 'row_duplicated' | 'fields_unreadable'
  | 'create_unverified' | 'write_unverified' | 'in_flight' | 'todo_changed' | 'facts_changed'

export interface PmoPending { reason: PmoPendingReason; count: number; code?: number; detail?: string }

const PENDING_TEXT: Record<PmoPendingReason, string> = {
  read_failed: '读取表格记录失败',
  read_incomplete: '表格记录没有读全',
  row_not_found: '表里按编号和作用域找不到对应的行',
  row_duplicated: '表里同一事项不止一行',
  fields_unreadable: '行里的状态、负责人或截止时间读不出来',
  create_unverified: '新建的行还没读回核对上',
  write_unverified: '更新还没读回核对上',
  in_flight: '另一轮同步正在处理',
  todo_changed: '同步期间本地事项被删除或移走',
  facts_changed: '更新已写入，但期间事实又变了',
}

/** 给人看的待核验原因：每类一句和条数，有平台错误码或原文的带上。 */
export function describePending(groups: readonly PmoPending[]): string {
  return groups.map(group => {
    const source = [group.code === undefined ? '' : `code=${group.code}`, group.detail ?? ''].filter(Boolean).join('：')
    return `${PENDING_TEXT[group.reason]}：${group.count} 条${source ? `（${source}）` : ''}`
  }).join('；')
}

/** 平台错误里能给人看的部分：错误码和平台原文（截短）。飞书接口的 HTTP 4xx 由 SDK 原样抛出 axios 错误，码和原文在响应体里。 */
export function platformError(error: unknown): { code?: number; detail: string } {
  const value = error as { code?: unknown; msg?: unknown; message?: unknown; response?: { data?: { code?: unknown; msg?: unknown } } } | null | undefined
  const code = typeof value?.code === 'number' ? value.code : typeof value?.response?.data?.code === 'number' ? value.response.data.code : undefined
  const text = [value?.response?.data?.msg, value?.msg, value?.message].find((part): part is string => typeof part === 'string' && part.trim() !== '')
  return { ...(code === undefined ? {} : { code }), detail: (text ?? String(error)).trim().slice(0, 200) }
}

export interface SyncResult {
  created: number
  updated: number
  skipped: number
  total: number
  /** 创建、更新或读取尚未核验；保留占位，不能自动重发未知写入。 */
  pending: number
  /** pending 按原因分组的条数。 */
  pendingReasons: PmoPending[]
  /** 之前的轮次没核验上、这一轮读回核对上的写入：建行占位记下正式指纹，或更新意图读到已写入。 */
  confirmed: number
  /** 平台明确拒绝、证明没有执行的写入；占位已撤销，下一轮按当时的事实重新规划。 */
  rejected: number
  /** 明确拒绝的错误码（不含正文），供宿主告诉看板负责人卡在哪里。 */
  rejections: { todoId: number; code: number }[]
}

/** A structured platform answer that proves the write was not performed. Server-side and transport
 * failures stay unknown. Bitable client errors are 1254xxx; 91402–91404 and 999916xx are access/scope;
 * 99991400 is the gateway frequency limit. */
export function definitiveRejection(error: unknown): number | undefined {
  const value = error as { definitive?: unknown; code?: unknown; response?: { status?: unknown; data?: { code?: unknown } } } | undefined
  const code = typeof value?.code === 'number' ? value.code : typeof value?.response?.data?.code === 'number' ? value.response.data.code : undefined
  if (value?.definitive === true && code !== undefined) return code
  if (value?.definitive === false || code === undefined || code === 0) return undefined
  if (code >= 1254000 && code < 1255000) return code
  if (code >= 91402 && code <= 91404) return code
  // Access/scope refusals, and the gateway frequency limit (99991400): all answered before any write happened.
  if ([99991400, 99991663, 99991668, 99991672, 99991679].includes(code)) return code
  return undefined
}

export class PmoSyncStopped extends Error {
  constructor() {
    super('看板同步已停止：空间、绑定或配置权限已经变化。已发出的写入会保留核验记录。')
    this.name = 'PmoSyncStopped'
  }
}

function recordScope(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => part && typeof part === 'object' && typeof part.text === 'string')) {
    return value.map((part) => part.text).join('')
  }
  return undefined
}

function fieldText(value: unknown): string | undefined {
  return value === undefined || value === null ? '' : recordScope(value)
}

function fieldDate(value: unknown): number | null | undefined {
  return value === undefined || value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 表内人工字段是本行风险的依据；本地账本只用于陈述差异，不能覆盖人。
 * association 是这一轮的「关联」内容；不给表示这一轮不写这一列，指纹里那一段沿用 known（上次记下的指纹）。 */
function recordProjection(todo: Todo, fields: Record<string, unknown>, now: number, association: string | undefined,
  known: string | undefined): { fields: Record<string, unknown>; fp: string } | undefined {
  const status = fieldText(fields['状态']), owner = fieldText(fields['负责人']), due = fieldDate(fields['截止时间'])
  if (status === undefined || owner === undefined || due === undefined) return undefined
  const local = { status: STATUS_LABEL[todo.status], owner: todo.owner ?? (todo.ownerOpenId ? '已指定成员（未记录姓名）' : ''), due: todo.dueMs }
  const notes: string[] = []
  let risk = ''
  if (!Object.values(STATUS_LABEL).includes(status as typeof STATUS_LABEL[keyof typeof STATUS_LABEL])) {
    notes.push('表格状态未识别，本次未判断风险')
  } else if (status !== STATUS_LABEL.done && status !== STATUS_LABEL.cancelled) {
    if (due !== null && due < now) {
      notes.push(`表格截止是 ${fmtDay(due)}，已经过去 ${Math.floor((now - due) / DAY)} 天`)
      risk = '已过截止'
    }
    if (!owner.trim()) {
      notes.push('表格负责人为空')
      if (!risk) risk = '没有负责人'
    }
  }
  // 「更新时间」是可编辑的普通列，不是状态字段的审计历史，不能据此声称状态几天没变。
  if (status !== local.status) notes.push(`表格状态为「${status || '空'}」，Friday 账本为「${local.status}」`)
  if (owner !== local.owner) notes.push(`表格负责人为「${owner || '空'}」，Friday 账本为「${local.owner || '空'}」`)
  if (due !== local.due) notes.push(`表格截止为「${due === null ? '未设置' : fmtDateTime(due)}」，Friday 账本为「${local.due === null ? '未设置' : fmtDateTime(local.due)}」`)
  const table = { status, owner, due }
  return {
    fields: { 'Friday 观察': notes.length ? `${notes.join('；')}。` : '', 风险: risk, ...(association === undefined ? {} : { 关联: association }) },
    // 日数文案和人清掉的风险不参与；事实或风险跨阈值才写下一次。
    // v3 splits the two columns: a Friday-ledger-only change rewrites the observation, never a risk a person cleared.
    // v4 keeps the v3 risk/observation parts unchanged and appends the「关联」part: only a link fact change rewrites that cell.
    fp: `v4:${fingerprint({ table, risk })}:${fingerprint({ table, local, risk })}:${association === undefined ? linkPart(known) : fingerprint({ link: association })}`,
  }
}

/** Own columns whose part of the fingerprint changed (v3 or v4; a v3 row has never had「关联」written).
 * Older (legacy) baselines are handled by the caller. */
function changedColumns(known: string, next: string): (typeof OWN_COLUMNS)[number][] {
  const [, knownRisk, knownObservation] = known.split(':'), [, nextRisk, nextObservation] = next.split(':')
  return [...(knownObservation !== nextObservation ? ['Friday 观察' as const] : []), ...(knownRisk !== nextRisk ? ['风险' as const] : []),
    ...(linkPart(known) !== linkPart(next) ? ['关联' as const] : [])]
}

/** Same risk/observation parts, with the「关联」part set to the given one. */
function withLinkPart(fp: string, link: string): string {
  const [version, risk, observation] = fp.split(':')
  return `${version}:${risk}:${observation}:${link}`
}

function ownFields(record: BitableRecord, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map(column => [column, fieldText(record.fields[column]) ?? null]))
}

function sameOwnFields(record: BitableRecord, expected: Record<string, unknown>): boolean {
  const columns = OWN_COLUMNS.filter(column => column in expected)
  return columns.length > 0 && columns.every(column => fieldText(record.fields[column]) === expected[column])
}

/** Readback of an unresolved update: reached; untouched since before the send; or changed by someone. */
function writeState(record: BitableRecord, write: PendingProjection): 'reached' | 'unchanged' | 'changed' {
  if (sameOwnFields(record, write.fields)) return 'reached'
  const columns = OWN_COLUMNS.filter(column => column in write.fields)
  if (write.previous && columns.every(column => fieldText(record.fields[column]) === write.previous![column])) return 'unchanged'
  return 'changed'
}

/**
 * 「编号」一格读回来的值。列是数字列，但飞书读记录接口实际把它返回成字符串，
 * 严格比较数字就永远对不上，建好的行一直停在待核验。只接受整数或纯数字字符串，其他一律当读不出。
 */
function recordNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function sameIdentity(record: BitableRecord, todo: Todo): boolean {
  return typeof record.recordId === 'string' && Boolean(record.recordId) && record.recordId !== 'undefined'
    && recordNumber(record.fields['编号']) === todo.id && recordScope(record.fields['作用域']) === todo.scope
}

/** 一次读表的结果：读全了才有 records；读不到或没读全时带原因。 */
interface RowsRead { records?: BitableRecord[]; problem?: Omit<PmoPending, 'count'> }

/**
 * 只导出绑定群空间本身的工作项；私聊、联盟、企业层和其他群不参与。
 * 外部表格的读者权限由配置者管理，此处不声称验证了表格受众。
 */
export async function syncWorkItems(
  deps: { bitable: Bitable; todos: Todos; store: PmoStore; assertCurrent?: () => void; links?: PmoLinks },
  binding: PmoBinding,
  space: Pick<Space, 'id' | 'kind' | 'status'>,
  spaceLabel: string,
  limit = 500,
): Promise<SyncResult> {
  if (space.kind !== 'group' || space.status !== 'active' || binding.spaceId !== space.id || !deps.store.owns(binding)) {
    throw new Error('PMO 只能同步已授权绑定的当前群空间')
  }
  const assertCurrent = () => {
    if (space.status !== 'active' || !deps.store.owns(binding)) throw new PmoSyncStopped()
    deps.assertCurrent?.()
  }
  assertCurrent()
  // 一轮最多一批，Bitable 内部的分页写入没有空间权限回调，不能把检查跨过多批 await。
  const batchLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), 500)) : 0
  const items = deps.todos.list([spaceScope(space.id)], { status: 'all', limit: batchLimit })
  const now = Date.now()
  // 「关联」列：先把本轮的链接状态读完（有上限、有限并发、读不到按未读到），之后的比较和写后核对都用这一份。
  const states = deps.links ? await readLinkStates(items, deps.links.readGitHub) : undefined
  assertCurrent()
  const project = (todo: Todo, fields: Record<string, unknown>) =>
    recordProjection(todo, fields, now, states && associate(todo, states), deps.store.get(binding, todo.id)?.fingerprint)
  const toCreate: { todo: Todo; fields: Record<string, unknown>; fp: string }[] = []
  const toUpdate: { todo: Todo; projection: PendingProjection }[] = []
  const toResend: { todo: Todo; projection: PendingProjection }[] = []
  const rejections: { todoId: number; code: number }[] = []
  let skipped = 0
  let pending = 0
  let created = 0
  let updated = 0
  let confirmed = 0
  const reasons = new Map<string, PmoPending>()
  /** 记待核验和原因；原因、错误码、原文都相同的合并计数。 */
  const pend = (problem: Omit<PmoPending, 'count'>, count = 1) => {
    if (count <= 0) return
    pending += count
    const key = JSON.stringify([problem.reason, problem.code, problem.detail])
    const group = reasons.get(key)
    if (group) group.count += count
    else reasons.set(key, { ...problem, count })
  }
  const readRows = async (): Promise<RowsRead> => {
    assertCurrent()
    let result: Awaited<ReturnType<Bitable['listRecords']>> | undefined, failure: unknown
    try { result = await deps.bitable.listRecords(binding.appToken, binding.tableId, { limit: 5000, assertCurrent }) }
    catch (error) { failure = error /* 读不到不等于不存在，更不能退回本地旧状态继续写；原因留给这一轮的待核验说明。 */ }
    assertCurrent()
    if (result?.complete) return { records: result.records }
    return { problem: result ? { reason: 'read_incomplete' } : { reason: 'read_failed', ...platformError(failure) } }
  }
  const findRow = (rows: RowsRead | undefined, todo: Todo, recordId?: string): BitableRecord | undefined => {
    const matches = rows?.records?.filter(record => sameIdentity(record, todo)) ?? []
    return matches.length === 1 && (!recordId || matches[0]!.recordId === recordId) ? matches[0] : undefined
  }
  /** findRow 没找到时的原因：读不到表或没读全；或按编号和作用域找到的不是恰好一行、不是记下的那一行。 */
  const missing = (rows: RowsRead | undefined, todo: Todo): Omit<PmoPending, 'count'> => !rows?.records ? rows?.problem ?? { reason: 'read_failed' }
    : rows.records.filter(record => sameIdentity(record, todo)).length > 1 ? { reason: 'row_duplicated' } : { reason: 'row_not_found' }
  const currentTodo = (todo: Todo): Todo | undefined => {
    const current = deps.todos.get(todo.id)
    return current?.scope === todo.scope ? current : undefined
  }
  // 每轮都读人工字段，包括本地 todo 完全没变的时候；列表不完整时不猜没有歧义。
  const rows = items.some(t => deps.store.get(binding, t.id)) ? await readRows() : undefined
  for (const snapshot of items) {
    assertCurrent()
    // Listing remote rows crossed an await. A local deletion, move or edit must
    // take effect before any new row is reserved or sent to the external table.
    const t = currentTodo(snapshot)
    if (!t) { skipped += 1; continue }
    let known = deps.store.get(binding, t.id)
    if (!known) {
      const fields = toFields(t, spaceLabel, now), projection = project(t, fields)!
      Object.assign(fields, projection.fields)
      toCreate.push({ todo: t, fields, fp: projection.fp })
      continue
    }
    const unverifiedCreate = !known.recordId || known.fingerprint.startsWith('pending-create:')
    const row = findRow(rows, t, unverifiedCreate ? undefined : known.recordId)
    if (!row) { pend(missing(rows, t)); continue }
    if (unverifiedCreate) {
      // 之前建的行这一轮按编号和作用域读回找到了：记下正式指纹。
      deps.store.remember(binding, t.id, row.recordId!, known.fingerprint.replace(/^pending-create:/, ''))
      known = deps.store.get(binding, t.id)!
      confirmed += 1
    }
    const projection = project(t, row.fields)
    if (!projection) { pend({ reason: 'fields_unreadable' }); continue }
    const previousWrite = deps.store.pendingWrite(binding, t.id)
    if (previousWrite) {
      const state = previousWrite.recordId === row.recordId ? writeState(row, previousWrite) : undefined
      if (state === 'reached') {
        // The update landed (possibly late). Record what was written; any newer facts are compared next round.
        deps.store.confirmWrite(binding, t.id, previousWrite)
        skipped += 1
        confirmed += 1
      } else if (state === 'changed') {
        // Someone else wrote Friday's columns after the intent. Their value stands until the facts change.
        deps.store.dropWrite(binding, t.id)
        deps.store.remember(binding, t.id, row.recordId!, projection.fp)
        skipped += 1
      } else if (state === 'unchanged' && projection.fp === previousWrite.fingerprint && (previousWrite.attempts ?? 1) < PMO_MAX_ATTEMPTS
        && now - (previousWrite.updatedAt ?? now) >= PMO_RETRY_DELAY_MS) {
        // Not observed, same target, repeating the same values is harmless: bounded resend of the same intent.
        toResend.push({ todo: t, projection: previousWrite })
      } else pend({ reason: 'write_unverified' })
      continue
    }
    // 旧版指纹没有表格事实或两列未拆开。首次只建立基线，不能把旧的人工清空当作待恢复的风险；
    // 「关联」那时还没有，基线里按空算。v3 行的前两段与 v4 相同，直接比较。
    const legacy = !/^v[34]:/.test(known.fingerprint)
    const baseline = legacy ? withLinkPart(projection.fp, EMPTY_LINK) : known.fingerprint
    if (legacy) deps.store.remember(binding, t.id, known.recordId, baseline)
    const columns = baseline === projection.fp ? [] : changedColumns(baseline, projection.fp)
    if (!columns.length) {
      // 事实没变；v3 行只把指纹换成 v4 写法，不写表。
      if (baseline !== projection.fp) deps.store.remember(binding, t.id, known.recordId, projection.fp)
      skipped += 1
    } else {
      toUpdate.push({ todo: t, projection: { recordId: known.recordId, fingerprint: projection.fp,
        fields: Object.fromEntries(columns.map(column => [column, projection.fields[column]])) } })
    }
  }
  if (toCreate.length) {
    assertCurrent()
    const reserved = toCreate.filter((x) => deps.store.reserveCreate(binding, x.todo.id, x.fp))
    pend({ reason: 'in_flight' }, toCreate.length - reserved.length)
    if (reserved.length) {
      let ids: string[] | undefined, rejected: number | undefined, failure: unknown
      try { ids = await deps.bitable.batchCreate(binding.appToken, binding.tableId, reserved.map((x) => ({ fields: x.fields }))) }
      catch (error) { failure = error; rejected = definitiveRejection(error) /* 否则请求可能已经生效，保留占位，下轮只读核验。 */ }
      if (rejected !== undefined) {
        // Explicitly refused as a whole batch: nothing was created, so the placeholders end and the next round re-plans.
        for (const item of reserved) { deps.store.forget(binding, item.todo.id); rejections.push({ todoId: item.todo.id, code: rejected }) }
      } else if (ids?.length === reserved.length && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && id.length > 0 && id !== 'undefined')) {
        ids.forEach((recordId, i) => {
          const item = reserved[i]!
          // 先保留实际回执，但读回编号和作用域前不能宣称已创建完成。
          deps.store.remember(binding, item.todo.id, recordId, `pending-create:${item.fp}`)
        })
        assertCurrent()
        const actual = await readRows()
        for (const item of reserved) {
          const row = findRow(actual, item.todo), current = currentTodo(item.todo)
          const projection = row && current && project(current, row.fields)
          if (row && ids.includes(row.recordId!) && projection?.fp === item.fp && sameOwnFields(row, item.fields)) {
            deps.store.remember(binding, item.todo.id, row.recordId!, item.fp)
            created += 1
          } else pend(row ? { reason: 'create_unverified' } : missing(actual, item.todo))
        }
      } else pend({ reason: 'create_unverified', ...(failure === undefined ? { detail: '建行回执里的记录编号数量或格式不对' } : platformError(failure)) }, reserved.length)
      // 回执记录是本地事实，即使刚被停用也先保留；之后绝不再发下一批写入。
      assertCurrent()
    }
  }
  if (toUpdate.length || toResend.length) {
    assertCurrent()
    // 创建与更新之间可能隔着一次网络等待；发更新前重新取人写字段和当前本地事实。
    const latest = await readRows()
    const reserved: (typeof toUpdate[number] & { resend?: boolean })[] = []
    for (const item of toUpdate) {
      const row = findRow(latest, item.todo, item.projection.recordId), current = currentTodo(item.todo)
      const projection = row && current && project(current, row.fields)
      if (!row || !projection || !current) { pend(!row ? missing(latest, item.todo) : !current ? { reason: 'todo_changed' } : { reason: 'fields_unreadable' }); continue }
      const known = deps.store.get(binding, current.id)?.fingerprint
      if (known === projection.fp) { skipped += 1; continue }
      const columns = known && /^v[34]:/.test(known) ? changedColumns(known, projection.fp) : OWN_COLUMNS.filter(column => column in projection.fields)
      if (!columns.length) { deps.store.remember(binding, current.id, item.projection.recordId, projection.fp); skipped += 1; continue }
      const write: PendingProjection = { recordId: item.projection.recordId, fingerprint: projection.fp,
        fields: Object.fromEntries(columns.map(column => [column, projection.fields[column]])), previous: ownFields(row, columns) }
      if (deps.store.reserveWrite(binding, current.id, write)) reserved.push({ todo: current, projection: write })
      else pend({ reason: 'in_flight' })
    }
    for (const item of toResend) {
      // Re-check just before resending: still untouched, still the same target, still the same intent row.
      const row = findRow(latest, item.todo, item.projection.recordId), current = currentTodo(item.todo)
      const projection = row && current && project(current, row.fields)
      const intent = current && deps.store.pendingWrite(binding, current.id)
      if (!row || !projection || !current || !intent || projection.fp !== intent.fingerprint || writeState(row, intent) !== 'unchanged'
        || !deps.store.markAttempt(binding, current.id, intent)) { pend(row ? { reason: 'write_unverified' } : missing(latest, item.todo)); continue }
      reserved.push({ todo: current, projection: intent, resend: true })
    }
    if (reserved.length) {
      let rejected: number | undefined, failure: unknown
      try { await deps.bitable.batchUpdate(binding.appToken, binding.tableId, reserved.map(x => ({ recordId: x.projection.recordId, fields: x.projection.fields }))) }
      catch (error) { failure = error; rejected = definitiveRejection(error) /* 否则回执未知，只读核验；只按上面的条件有限次重发同一内容。 */ }
      assertCurrent()
      if (rejected !== undefined) {
        for (const item of reserved) { deps.store.dropWrite(binding, item.todo.id); rejections.push({ todoId: item.todo.id, code: rejected }) }
      } else {
        const actual = await readRows()
        for (const item of reserved) {
          const row = findRow(actual, item.todo, item.projection.recordId), current = currentTodo(item.todo)
          const projection = row && current && project(current, row.fields)
          const state = row ? writeState(row, item.projection) : undefined
          if (state === 'reached') {
            deps.store.confirmWrite(binding, item.todo.id, item.projection)
            // A write that landed while the facts moved on is recorded, but is not a current result.
            if (projection?.fp === item.projection.fingerprint) updated += 1
            else pend({ reason: !current ? 'todo_changed' : !projection ? 'fields_unreadable' : 'facts_changed' })
          } else if (state === 'changed' && row && projection) {
            deps.store.dropWrite(binding, item.todo.id)
            deps.store.remember(binding, item.todo.id, row.recordId!, projection.fp)
            skipped += 1
          } else pend(!row ? missing(actual, item.todo) : { reason: 'write_unverified', ...(failure === undefined ? {} : platformError(failure)) })
        }
      }
    }
    assertCurrent()
  }
  return { created, updated, skipped, pending, pendingReasons: [...reasons.values()], confirmed, total: items.length, rejected: rejections.length, rejections }
}
