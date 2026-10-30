/**
 * 待办 / 里程碑：Friday 在对话里发现的承诺、排期、截止日、封版、上线，按群或按人保存，
 * 供"提醒要做什么"、日报和 PMO 汇总用。
 *
 * - kind：todo（普通待办）、deadline（截止日）、freeze（封版）、release（上线）、meeting（会议/评审）
 * - confirmed：模型从聊天里推断的先是"候选"（confirmed=0），负责人/发起人确认后才算数；提醒时会标出来
 * - 多级提醒：截止日/封版/上线 提前 3 天、1 天、2 小时各提醒一次，过期再提醒一次；普通待办提前 1 天一次
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseTodoProvenance, serializeTodoProvenance, todoOrigin, type TodoOrigin, type TodoProvenance } from './todo-provenance.js'

/**
 * 工作项的状态机（企业双边 Agent 方案里的 WorkItem）：
 *
 *   open ──接受/开工──→ open（confirmed=1）
 *    │ └─阻塞→ blocked ──解除──→ open
 *    ├─交付→ review ──验收通过──→ done
 *    │         └──退回──→ open
 *    └─不做了→ cancelled
 *
 * confirmed 是另一个维度：模型从聊天里推断的先 confirmed=0（候选），负责人确认后才算承诺。
 * 老数据只有 open / done，不受影响。
 */
export type TodoStatus = 'open' | 'blocked' | 'review' | 'done' | 'cancelled'

/** 还"活着"的状态：要提醒、要进周报的进行中部分 */
export const ACTIVE_STATUSES: TodoStatus[] = ['open', 'blocked', 'review']

export const STATUS_LABEL: Record<TodoStatus, string> = {
  open: '进行中',
  blocked: '阻塞',
  review: '待验收',
  done: '已完成',
  cancelled: '已取消',
}

/** 合法迁移；不在表里的直接拒绝，避免"已完成"被莫名其妙改回去。 */
const TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  // 阻塞 / 待验收 允许"原地再说一次"：换个阻塞原因、补一句验收说明
  open: ['blocked', 'review', 'done', 'cancelled'],
  blocked: ['blocked', 'open', 'review', 'done', 'cancelled'],
  review: ['review', 'open', 'done', 'cancelled'],
  // 已完成 / 已取消 只能重开；再"完成"一次是无意义的，调用方据此回一句"已经完成过了"
  done: ['open'],
  cancelled: ['open'],
}

export function canTransition(from: TodoStatus, to: TodoStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}
export type TodoKind = 'todo' | 'deadline' | 'freeze' | 'release' | 'meeting'
type TodoFilter = { status?: TodoStatus | 'all' | 'active'; kind?: TodoKind }
/** Host-authorized Space audience; query filtering does not itself grant access. */
export interface TodoAudience {
  scope: string
  chatId: string | null
  chatType: 'group' | 'p2p'
  openId: string
}

/** 列表与计数共用筛选，避免总数混入其他空间、状态或类型。 */
function listFilter(scope: string | string[], opts: TodoFilter): { where: string; params: string[] } | undefined {
  const scopes = Array.isArray(scope) ? scope : [scope]
  if (!scopes.length) return undefined
  const where = [`scope IN (${scopes.map(() => '?').join(', ')})`]
  const params = [...scopes]
  const status = opts.status ?? 'open'
  if (status === 'active') where.push(`status IN ('open', 'blocked', 'review')`)
  else if (status !== 'all') {
    where.push('status = ?')
    params.push(status)
  }
  if (opts.kind) {
    where.push('kind = ?')
    params.push(opts.kind)
  }
  return { where: where.join(' AND '), params }
}

export interface Todo {
  id: number
  scope: string
  kind: TodoKind
  title: string
  detail: string | null
  dueMs: number | null
  /** 负责人（显示名） */
  owner: string | null
  /** 负责人 open_id（有它才能私聊提醒 / @） */
  ownerOpenId: string | null
  status: TodoStatus
  /** 状态变更的一句话说明（阻塞原因、退回理由…） */
  statusNote: string | null
  statusAt: number | null
  statusBy: string | null
  confirmed: boolean
  /** 这条是从哪儿来的（"主动巡检 · 研发群""职责：竞品日报"）。人要能一眼看出不是自己写的 */
  source: string | null
  /** Safe display projection only; full creation evidence is host-only via getProvenance. */
  origin: TodoOrigin | null
  createdBy: string | null
  sessionKey: string | null
  createdAt: number
  doneAt: number | null
  remindedAt: number | null
  remindedStages: string[]
}

export type ReminderStage = '72h' | '24h' | '2h' | '1h' | 'overdue'
export interface DueReminder { todo: Todo; stage: ReminderStage; skipped: ReminderStage[] }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  due_ms INTEGER,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  session_key TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_todos_scope ON todos(scope, status, due_ms);
`

const STAGE_OFFSET_MS: Record<Exclude<ReminderStage, 'overdue'>, number> = { '72h': 72 * 3600_000, '24h': 24 * 3600_000, '2h': 2 * 3600_000, '1h': 3600_000 }

/** 各类事项的提醒节奏（从早到晚） */
export function stagesFor(kind: TodoKind): ReminderStage[] {
  switch (kind) {
    case 'deadline':
    case 'freeze':
    case 'release':
      return ['72h', '24h', '2h', 'overdue']
    case 'meeting':
      return ['24h', '1h']
    default:
      return ['24h', 'overdue']
  }
}

export const KIND_LABEL: Record<TodoKind, string> = { todo: '待办', deadline: '截止', freeze: '封版', release: '上线', meeting: '会议' }

export class Todos {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    const cols = (db.prepare('PRAGMA table_info(todos)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('reminded_at')) db.exec('ALTER TABLE todos ADD COLUMN reminded_at INTEGER')
    if (!cols.includes('kind')) db.exec(`ALTER TABLE todos ADD COLUMN kind TEXT NOT NULL DEFAULT 'todo'`)
    if (!cols.includes('owner_open_id')) db.exec('ALTER TABLE todos ADD COLUMN owner_open_id TEXT')
    if (!cols.includes('confirmed')) db.exec('ALTER TABLE todos ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1')
    if (!cols.includes('source')) db.exec('ALTER TABLE todos ADD COLUMN source TEXT')
    if (!cols.includes('provenance_json')) db.exec('ALTER TABLE todos ADD COLUMN provenance_json TEXT')
    if (!cols.includes('reminded_stages')) db.exec(`ALTER TABLE todos ADD COLUMN reminded_stages TEXT NOT NULL DEFAULT '[]'`)
    // 状态机：阻塞原因 / 退回理由 + 谁什么时候改的
    if (!cols.includes('status_note')) db.exec('ALTER TABLE todos ADD COLUMN status_note TEXT')
    if (!cols.includes('status_at')) db.exec('ALTER TABLE todos ADD COLUMN status_at INTEGER')
    if (!cols.includes('status_by')) db.exec('ALTER TABLE todos ADD COLUMN status_by TEXT')
  }

  add(input: { scope: string; title: string; kind?: TodoKind; detail?: string; dueMs?: number; owner?: string; ownerOpenId?: string; confirmed?: boolean; createdBy?: string; sessionKey?: string; source?: string; provenance?: TodoProvenance }): Todo {
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200)
    const provenance = input.provenance === undefined ? null : serializeTodoProvenance(input.provenance)
    const res = this.db
      .prepare(
        `INSERT INTO todos (scope, kind, title, detail, due_ms, owner, owner_open_id, status, confirmed, created_by, session_key, source, provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope,
        input.kind ?? 'todo',
        title,
        input.detail?.slice(0, 2000) ?? null,
        input.dueMs ?? null,
        input.owner ?? null,
        input.ownerOpenId ?? null,
        input.confirmed === false ? 0 : 1,
        input.createdBy ?? null,
        input.sessionKey ?? null,
        input.source ?? null,
        provenance,
        Date.now(),
      )
    return this.get(Number(res.lastInsertRowid)) as Todo
  }

  get(id: number): Todo | undefined {
    const r = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toTodo(r) : undefined
  }

  /** Host-only audit evidence; this method is not a model tool or an authorization grant. */
  getProvenance(id: number): TodoProvenance | null {
    const row = this.db.prepare('SELECT provenance_json FROM todos WHERE id = ?').get(id)
    return parseTodoProvenance(row?.provenance_json)
  }

  /** 某段时间内完成的（周报用）。窗口两端都含，因为 toMs 通常就是"现在"，刚刚完成的也该算进来。 */
  completedBetween(scope: string | string[], fromMs: number, toMs: number, limit = 100): Todo[] {
    const scopes = Array.isArray(scope) ? scope : [scope]
    if (!scopes.length) return []
    const marks = scopes.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE scope IN (${marks}) AND status = 'done' AND done_at IS NOT NULL AND done_at >= ? AND done_at <= ? ORDER BY done_at DESC LIMIT ?`)
      .all(...scopes, fromMs, toMs, limit) as Record<string, unknown>[]
    return rows.map(toTodo)
  }

  /** status 省略 = 'open'（只看进行中）；'active' = 进行中 + 阻塞 + 待验收；'all' = 全部。 */
  list(scope: string | string[], opts: TodoFilter & { limit?: number } = {}): Todo[] {
    const filter = listFilter(scope, opts)
    if (!filter) return []
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE ${filter.where} ORDER BY status ASC, coalesce(due_ms, 9e15) ASC, created_at DESC LIMIT ?`)
      .all(...filter.params, opts.limit ?? 50) as Record<string, unknown>[]
    return rows.map(toTodo)
  }

  /**
   * 「我的任务」按**归属**取，不按**记在哪个空间**取。
   *
   * 别人在群里派给我的事，记在那个群的空间里、owner 是我——只查私聊空间就永远看不见它，
   * 而这恰恰是这个清单最主要的来源。私聊空间里没写 owner 的默认算本人的（那是他自己跟我说的）。
   */
  listOwnedBy(openId: string, opts: TodoFilter & { limit?: number; dmScope?: string } = {}): Todo[] {
    const status = opts.status ?? 'active'
    const clauses: string[] = []
    const params: (string | number)[] = [openId]
    clauses.push('owner_open_id = ?')
    // Same rule as responsibleOpenId: an unnamed owner in this person's own private chat is that person.
    // A private-chat item recorded for a named other person without open_id is not theirs to count.
    const dmScopes = opts.dmScope ? [...new Set([opts.dmScope, `user:${openId}`])].filter(scope => dmPersonOf(scope) === openId) : []
    if (dmScopes.length) { clauses.push(`(owner_open_id IS NULL AND owner IS NULL AND scope IN (${dmScopes.map(() => '?').join(',')}))`); params.push(...dmScopes) }
    let where = `(${clauses.join(' OR ')})`
    if (status === 'active') where += ` AND status IN ('open','blocked','review')`
    else if (status !== 'all') { where += ' AND status = ?'; params.push(status) }
    if (opts.kind) { where += ' AND kind = ?'; params.push(opts.kind) }
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE ${where} ORDER BY status ASC, coalesce(due_ms, 9e15) ASC, created_at DESC, id DESC LIMIT ?`)
      .all(...params, opts.limit ?? 50) as Record<string, unknown>[]
    return rows.map(toTodo)
  }

  /** Exclude known foreign session origins before paging/count; missing legacy origins stay unverified. */
  listForAudience(audience: TodoAudience, opts: TodoFilter & { limit?: number } = {}): { items: Todo[]; total: number } {
    const limit = opts.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('待办分页条数须为 1–1000')
    const { where, params } = this.audienceFilter(audience, opts)
    const rows = this.db.prepare(`SELECT * FROM todos WHERE ${where}
      ORDER BY status ASC,coalesce(due_ms,9e15) ASC,created_at DESC,id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[]
    const count = this.db.prepare(`SELECT count(*) AS total FROM todos WHERE ${where}`).get(...params) as { total: number }
    return { items: rows.map(toTodo), total: Number(count.total) }
  }

  /** Same origin boundary as the audience list, including terminal records for explicit reopening. */
  getForAudience(id: number, audience: TodoAudience): Todo | undefined {
    const { where, params } = this.audienceFilter(audience, { status: 'all' })
    const row = this.db.prepare(`SELECT * FROM todos WHERE id = ? AND ${where}`).get(id, ...params) as Record<string, unknown> | undefined
    return row ? toTodo(row) : undefined
  }

  private audienceFilter(audience: TodoAudience, opts: TodoFilter): { where: string; params: (string | null)[] } {
    const filter = listFilter(audience.scope, opts)!
    const hasSessions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
    const where = filter.where + (hasSessions ? ` AND NOT EXISTS (SELECT 1 FROM sessions origin
      WHERE origin.session_key = todos.session_key AND (origin.chat_id IS NOT ? OR origin.chat_type != ?
        OR (? = 'p2p' AND origin.requester_open_id IS NOT ?)))` : '')
    const params: (string | null)[] = [...filter.params,
      ...(hasSessions ? [audience.chatId, audience.chatType, audience.chatType, audience.openId] : [])]
    return { where, params }
  }

  count(scope: string | string[], opts: TodoFilter = {}): number {
    const filter = listFilter(scope, opts)
    if (!filter) return 0
    const row = this.db.prepare(`SELECT count(*) AS total FROM todos WHERE ${filter.where}`).get(...filter.params) as { total: number }
    return Number(row.total)
  }

  /** 只允许在同一作用域内完成，避免跨群误操作。 */
  done(id: number, scope: string): Todo | undefined {
    return this.transition(id, scope, 'done')
  }

  confirm(id: number, scope: string): Todo | undefined {
    const res = this.db.prepare(`UPDATE todos SET confirmed = 1 WHERE id = ? AND scope = ? AND status IN ('open', 'blocked', 'review')`).run(id, scope)
    return Number(res.changes) ? this.get(id) : undefined
  }

  /**
   * 状态机迁移。非法迁移返回 undefined（调用方据此给人一句话解释），
   * 重开一件已完成/已取消的事会清掉完成时间，并重算提醒。
   */
  transition(id: number, scope: string, to: TodoStatus, opts: { by?: string; note?: string; now?: number } = {}): Todo | undefined {
    const t = this.get(id)
    if (!t || t.scope !== scope) return undefined
    if (!canTransition(t.status, to)) return undefined
    const now = opts.now ?? Date.now()
    const sets = ['status = ?', 'status_note = ?', 'status_at = ?', 'status_by = ?']
    const params: (string | number | null)[] = [to, opts.note?.trim().slice(0, 300) ?? null, now, opts.by ?? null]
    if (to === 'done') sets.push('done_at = ?'), params.push(now)
    else if (t.status === 'done' || t.status === 'cancelled') sets.push('done_at = NULL', `reminded_stages = '[]'`, 'reminded_at = NULL')
    params.push(id, scope)
    this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND scope = ?`).run(...params)
    return this.get(id)
  }

  /** 改期 / 改负责人（同作用域）。 */
  update(id: number, scope: string, patch: { dueMs?: number | null; owner?: string | null; ownerOpenId?: string | null; title?: string; detail?: string | null }): Todo | undefined {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.dueMs !== undefined) {
      sets.push('due_ms = ?', `reminded_stages = '[]'`, 'reminded_at = NULL')
      params.push(patch.dueMs)
    }
    if (patch.owner !== undefined) {
      sets.push('owner = ?')
      params.push(patch.owner)
    }
    if (patch.ownerOpenId !== undefined) {
      sets.push('owner_open_id = ?')
      params.push(patch.ownerOpenId)
    }
    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(patch.title.replace(/\s+/g, ' ').trim().slice(0, 200))
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?')
      params.push(patch.detail?.slice(0, 2000) ?? null)
    }
    if (!sets.length) {
      const current = this.get(id)
      return current?.scope === scope ? current : undefined
    }
    const res = this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND scope = ? AND status IN ('open', 'blocked', 'review')`).run(...params, id, scope)
    return Number(res.changes) ? this.get(id) : undefined
  }

  remove(id: number, scope: string): boolean {
    return Number(this.db.prepare('DELETE FROM todos WHERE id = ? AND scope = ?').run(id, scope).changes) > 0
  }

  /** 快到期或已过期的未完成事项（提醒用）。 */
  dueWithin(scope: string, withinMs: number, nowMs = Date.now()): Todo[] {
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE scope = ? AND status IN ('open', 'blocked', 'review') AND due_ms IS NOT NULL AND due_ms <= ? ORDER BY due_ms ASC`)
      .all(scope, nowMs + withinMs) as Record<string, unknown>[]
    return rows.map(toTodo)
  }

  /**
   * 所有作用域里到了某个提醒节点、还没提醒过的未完成事项（网关每分钟扫一次）。
   * 一件事只提醒它当前该提醒的那一级：刚记进来就已经在 24h 内的，跳过 72h 直接按 24h 提醒；过期只提醒一次。
   */
  dueForReminder(nowMs = Date.now(), limit = 50): DueReminder[] {
    const out: DueReminder[] = []
    for (const item of this.reminderCandidates(nowMs)) {
      if (out.length >= limit) break
      out.push(item)
    }
    return out
  }

  /** 本轮候选快照；不跨 await 持有 SQLite 游标。应用限制新投递数，旧已提醒/不可交付行不饿死后续待办。 */
  *reminderCandidates(nowMs = Date.now()): IterableIterator<DueReminder> {
    const rows = this.db
      .prepare(`SELECT * FROM todos WHERE status IN ('open', 'blocked', 'review') AND due_ms IS NOT NULL AND due_ms <= ? ORDER BY due_ms ASC, id ASC`)
      .all(nowMs + STAGE_OFFSET_MS['72h']) as Record<string, unknown>[]
    for (const r of rows) {
      // Personal collection has its own digest/quiet-hours policy. Never feed a backfill into legacy per-item reminders.
      if (parseTodoProvenance(r.provenance_json)?.collection) continue
      const todo = toTodo(r)
      const item = reminderFor(todo, nowMs)
      if (item) yield item
    }
  }

  /** 仅将同一截止时间的实际 ACK 写回；旧发送不能污染已改期/关闭/删除的待办。 */
  acknowledgeReminder(id: number, expected: { scope: string; dueMs: number; stages: ReminderStage[] }, nowMs = Date.now()): boolean {
    this.db.exec('SAVEPOINT todo_reminder_ack')
    try {
      const todo = this.get(id)
      if (!todo || todo.scope !== expected.scope || todo.dueMs !== expected.dueMs || !ACTIVE_STATUSES.includes(todo.status)) {
        this.db.exec('RELEASE todo_reminder_ack')
        return false
      }
      const merged = [...new Set([...todo.remindedStages, ...expected.stages])]
      this.db.prepare('UPDATE todos SET reminded_at = ?, reminded_stages = ? WHERE id = ?').run(nowMs, JSON.stringify(merged), id)
      this.db.exec('RELEASE todo_reminder_ack')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK TO todo_reminder_ack; RELEASE todo_reminder_ack')
      throw error
    }
  }

  markReminded(id: number, stages: ReminderStage | ReminderStage[] = '24h', nowMs = Date.now()): void {
    const t = this.get(id)
    if (!t) return
    const list = Array.isArray(stages) ? stages : [stages]
    const merged = [...new Set([...t.remindedStages, ...list])]
    this.db.prepare('UPDATE todos SET reminded_at = ?, reminded_stages = ? WHERE id = ?').run(nowMs, JSON.stringify(merged), id)
  }
}

/** Content CAS, not an authorization token. Reminder acknowledgements do not invalidate editing. */
export function todoTag(todo: Todo): string {
  return createHash('sha256').update(JSON.stringify([
    todo.id, todo.scope, todo.sessionKey, todo.kind, todo.title, todo.detail, todo.dueMs,
    todo.status, todo.statusNote, todo.statusAt, todo.statusBy, todo.doneAt,
    todo.owner, todo.ownerOpenId, todo.confirmed, todo.source, todo.createdBy, todo.createdAt,
  ])).digest('hex')
}

/** The person whose own private chat this scope is; group and unknown scopes have none. */
export function dmPersonOf(scope: string): string | null {
  const match = /^space:sp_dm_(.+)$/.exec(scope) ?? /^user:(.+)$/.exec(scope)
  return match?.[1] ? match[1] : null
}

/**
 * The one responsibility rule shared by native Task sync, My Day and personal lists.
 * An explicit open_id wins. Only an item with no named owner in someone's own private
 * chat belongs to that person; a bare name (“帮小王记”) or an ownerless group item is unknown.
 */
export function responsibleOpenId(todo: Pick<Todo, 'scope' | 'owner' | 'ownerOpenId'>): string | null {
  if (todo.ownerOpenId) return todo.ownerOpenId
  return todo.owner === null ? dmPersonOf(todo.scope) : null
}

/** 当前最晚应提醒阶段；供最后准入再次核对，不改变既有阶段语义。 */
export function reminderFor(todo: Todo, nowMs: number): DueReminder | undefined {
  if (!ACTIVE_STATUSES.includes(todo.status) || todo.dueMs === null || !Number.isFinite(todo.dueMs)) return undefined
  const pending = stagesFor(todo.kind).filter((s) => !todo.remindedStages.includes(s))
  const reached = pending.filter((s) => s === 'overdue' ? todo.dueMs! < nowMs : todo.dueMs! - STAGE_OFFSET_MS[s] <= nowMs)
  if (!reached.length) return undefined
  const stage = reached.includes('overdue') ? 'overdue' : reached[reached.length - 1]!
  return { todo, stage, skipped: reached.filter((s) => s !== stage) }
}

function toStatus(v: unknown): TodoStatus {
  return v === 'blocked' || v === 'review' || v === 'done' || v === 'cancelled' ? v : 'open'
}

function toTodo(r: Record<string, unknown>): Todo {
  let stages: string[] = []
  try {
    const parsed = JSON.parse(String(r.reminded_stages ?? '[]')) as unknown
    if (Array.isArray(parsed)) stages = parsed.map(String)
  } catch {
    /* ignore */
  }
  const kind = String(r.kind ?? 'todo')
  return {
    id: Number(r.id),
    scope: String(r.scope),
    kind: (['todo', 'deadline', 'freeze', 'release', 'meeting'].includes(kind) ? kind : 'todo') as TodoKind,
    title: String(r.title),
    detail: (r.detail as string | null) ?? null,
    dueMs: r.due_ms === null || r.due_ms === undefined ? null : Number(r.due_ms),
    owner: (r.owner as string | null) ?? null,
    ownerOpenId: (r.owner_open_id as string | null) ?? null,
    status: toStatus(r.status),
    statusNote: (r.status_note as string | null) ?? null,
    statusAt: r.status_at === null || r.status_at === undefined ? null : Number(r.status_at),
    statusBy: (r.status_by as string | null) ?? null,
    confirmed: Number(r.confirmed ?? 1) === 1,
    source: r.source === null || r.source === undefined ? null : String(r.source),
    origin: todoOrigin(parseTodoProvenance(r.provenance_json)),
    createdBy: (r.created_by as string | null) ?? null,
    sessionKey: (r.session_key as string | null) ?? null,
    createdAt: Number(r.created_at),
    doneAt: r.done_at === null || r.done_at === undefined ? null : Number(r.done_at),
    remindedAt: r.reminded_at === null || r.reminded_at === undefined ? null : Number(r.reminded_at),
    remindedStages: stages,
  }
}
