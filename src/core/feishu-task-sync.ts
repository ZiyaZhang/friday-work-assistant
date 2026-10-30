/** Native Task replication uses a per-field acknowledged baseline. An unknown write is read back; it is
 * retried only when repeating that exact request is harmless and the local intent has not changed, and is
 * otherwise left for a person to decide. client_token is not a permanent exactly-once guarantee. */
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { FeishuTaskError, type FeishuTask, type FeishuTasks, type PatchTaskInput } from '../feishu/tasks.js'
import { responsibleOpenId, todoTag, type Todo, type Todos } from './todos.js'
import type { Logger } from '../log.js'
import { assertRequestCurrent } from './request-lease.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feishu_task_links (
  todo_id INTEGER PRIMARY KEY, guid TEXT NOT NULL, url TEXT, owner_open_id TEXT,
  created_at INTEGER NOT NULL, synced_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feishu_task_links_guid ON feishu_task_links(guid);
CREATE TABLE IF NOT EXISTS feishu_task_operations (
  id TEXT PRIMARY KEY, todo_id INTEGER NOT NULL, generation INTEGER NOT NULL,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
  result_json TEXT, error_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_task_operation_pending
  ON feishu_task_operations(todo_id) WHERE state = 'started';
CREATE TABLE IF NOT EXISTS feishu_task_permission_blocks (
  capability TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, version TEXT NOT NULL,
  code INTEGER NOT NULL, scopes_json TEXT NOT NULL
);`

/** Schema only: no network, effects or recovery. */
export function ensureFeishuTaskSyncSchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
  const columns = db.prepare('PRAGMA table_info(feishu_task_links)').all().map(row => row.name)
  for (const [name, type] of [['snapshot_json', 'TEXT'], ['generation', 'INTEGER NOT NULL DEFAULT 0'],
    ['deleted_at', 'INTEGER'], ['issue_json', 'TEXT'], ['last_verified_at', 'INTEGER']] as const) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE feishu_task_links ADD COLUMN ${name} ${type}`)
  }
  // Every existing operation row was sent exactly once; later retries of the same request increment this.
  const operationColumns = db.prepare('PRAGMA table_info(feishu_task_operations)').all().map(row => row.name)
  if (!operationColumns.includes('attempts')) db.exec('ALTER TABLE feishu_task_operations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1')
}
/** A link or a started/acknowledged native write means a Feishu task may exist or may still appear.
 * Rejected operations were proven unperformed and do not count. Read-only; safe before schema setup. */
export function nativeTaskRecorded(db: DatabaseSync, todoId: number): boolean {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('feishu_task_links','feishu_task_operations')").all().map(row => String(row.name)))
  if (tables.has('feishu_task_links') && db.prepare('SELECT 1 FROM feishu_task_links WHERE todo_id=?').get(todoId)) return true
  return tables.has('feishu_task_operations') && !!db.prepare("SELECT 1 FROM feishu_task_operations WHERE todo_id=? AND state IN ('started','returned')").get(todoId)
}
type Field = 'summary' | 'description' | 'dueMs' | 'done'
type Projection = { summary: string; description: string | null; dueMs: number | null; done: boolean }
type Identity = { scope: string; sessionKey: string | null; owner: string; createdAt: number }
type Anchor = Omit<Identity, 'owner'>
type Snapshot = { identity: Identity; local: Projection; remote: Projection; statusAt: number | null; remoteAllDay: boolean
  /** recreate: a person chose to keep Friday's content after the task was deleted in Feishu. */
  deletion?: { status: Todo['status']; statusAt: number | null; source: 'provider' | 'readback'; recreate?: true }
  /** Assignees Friday itself added during an unfinished transfer; only these (and the previous owner) may be removed. */
  transfer?: { ours: string[] } }
type Kind = 'create' | 'patch' | 'delete' | 'add_member' | 'remove_member'
/** Scopes a native call needs. A missing one stops only the calls that need it. */
export type TaskCapability = 'read' | 'write' | 'delete' | 'members'
type WritePayload = { snapshot: Snapshot; localTag: string; guid?: string; patch?: PatchTaskInput; fields?: Field[]; marker?: string; token?: string; from?: string; to?: string }
type Operation = { id: string; todoId: number; generation: number; kind: Kind; payload: WritePayload; attempts: number; updatedAt: number }
export type TaskSyncIssue = { reason: 'conflict' | 'identity_changed' | 'legacy_conflict' | 'unknown_write' | 'cancellation_policy_required' | 'invalid_remote'
  | 'resource_denied' | 'remote_missing' | 'read_failed' | 'permission_required' | 'owner_unknown' | 'request_rejected'; fields?: readonly string[]; code?: number }
export interface TaskLink {
  todoId: number; guid: string; url: string | null; ownerOpenId: string | null; completedAt: number | null
  generation: number; deletedAt: number | null; issue?: TaskSyncIssue
}
export interface TaskSyncResult {
  created: number; completed: number; pulledBack: number; skipped: number
  updated: number; reopened: number; cancelled: number; conflicts: number; unknown: number
  transferred: number; retried: number
  blocked?: boolean; retryAt?: number; blockedCapabilities?: TaskCapability[]
}
/** What a person may be told about the native Feishu task. A local save alone is never “synced”. */
export type NativeTaskState = 'not_applicable' | 'owner_unknown' | 'queued' | 'local_pending' | 'syncing' | 'transferring' | 'synced'
  | 'deleted' | 'unverified' | 'needs_decision' | 'permission_required' | 'unavailable'
export interface NativeTaskView { state: NativeTaskState; label: string; url?: string; fields?: readonly string[]
  lastSuccessAt?: number | null; requiredScopes?: string[]; retryAt?: number; nextStep?: string }
export interface NativeTaskAvailability {
  source: 'feishu_tasks'; coverage: 'friday_mirror_only'
  state: 'not_checked' | 'available' | 'permission_required' | 'retrying'; label: string
  /** Only successful observations of the caller's already-authorized items. */
  lastSuccessAt: number | null; blockedCapabilities: TaskCapability[]; requiredScopes: string[]
  nextRetryAt: number | null; nextStep: string | null
}
type PermissionBlock = { until: number; version: string; code: number; scopes: string[] }

/** Total sends of one unknown request, including the first; and the wait before repeating it. */
export const MAX_NATIVE_ATTEMPTS = 3
export const NATIVE_RETRY_DELAY_MS = 60_000
/** Platform frequency limit: every native call waits this long. */
export const NATIVE_RATE_LIMIT_WAIT_MS = 60_000
const CAPABILITIES: readonly TaskCapability[] = ['read', 'write', 'delete', 'members']
const capabilityOf = (kind: Kind): TaskCapability => kind === 'delete' ? 'delete' : kind === 'add_member' || kind === 'remove_member' ? 'members' : 'write'
const fields: readonly Field[] = ['summary', 'description', 'dueMs', 'done']
const localOf = (todo: Todo): Projection => ({ summary: todo.title, description: todo.detail || null, dueMs: todo.dueMs, done: todo.status === 'done' })
const remoteOf = (task: FeishuTask): Projection => ({ summary: task.summary, description: task.description || null, dueMs: task.dueMs ?? null, done: !!task.completedAt })
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const anchorOf = (value: Anchor): Anchor => ({ scope: value.scope, sessionKey: value.sessionKey, createdAt: value.createdAt })
const assigneesOf = (task: FeishuTask): string[] | undefined => task.assigneeOpenIds ? [...task.assigneeOpenIds].sort() : undefined
const PERMISSION_LABEL: Record<string, string> = {
  delete: '缺少飞书任务删除权限，飞书里的任务还没删', members: '缺少飞书任务成员权限，负责人还没转过去',
  write: '缺少飞书任务写入权限，修改还没同步', read: '缺少飞书任务读取权限，无法核对飞书里的状态',
}

function issueView(issue: TaskSyncIssue): NativeTaskView {
  const withFields = issue.fields ? { fields: issue.fields } : {}
  switch (issue.reason) {
    case 'conflict': return { state: 'needs_decision', label: issue.fields?.includes('owner') ? '飞书里负责人被改了，需要你决定以哪边为准'
      : issue.fields?.includes('cancel') ? 'Friday 里已取消，但飞书里的任务被人改过，需要你决定以哪边为准' : '飞书和 Friday 同时改了同一项，需要你决定以哪边为准', ...withFields }
    case 'legacy_conflict': return { state: 'needs_decision', label: '旧记录和飞书任务内容不一致，需要你决定以哪边为准' }
    case 'invalid_remote': return { state: 'needs_decision', label: '飞书里的内容超出 Friday 能保存的长度，需要你决定以哪边为准' }
    case 'remote_missing': return { state: 'needs_decision', label: '飞书里这条任务已被删除，而 Friday 里还有新修改：保留 Friday 的会重新建一条，以飞书为准会取消本地' }
    case 'unknown_write': return { state: 'unverified', label: issue.fields?.includes('create') ? '飞书任务是否已创建还在核对' : '飞书任务的修改结果还在核对', ...withFields }
    case 'permission_required': return { state: 'permission_required', label: PERMISSION_LABEL[issue.fields?.[0] ?? 'write'] ?? PERMISSION_LABEL.write!, ...withFields }
    case 'request_rejected': return { state: 'unavailable', label: `飞书拒绝了这次同步${issue.code ? `（code=${issue.code}）` : ''}，内容改动后会重新尝试`, ...withFields }
    case 'owner_unknown': return { state: 'owner_unknown', label: '负责人未确认，已暂停同步飞书任务' }
    case 'resource_denied': return { state: 'unavailable', label: 'Friday 没有这条飞书任务的访问权' }
    case 'read_failed': return { state: 'unavailable', label: '暂时读不到飞书任务，稍后会重试' }
    case 'identity_changed': return { state: 'unavailable', label: '事项的空间或确认状态变了，已停止同步' }
    case 'cancellation_policy_required': return { state: 'unavailable', label: '没有配置取消后的处理方式，飞书任务保持原样' }
  }
}

export class FeishuTaskSync {
  private active?: Promise<TaskSyncResult>
  private readonly blocks = new Map<TaskCapability, PermissionBlock>()
  private rateLimitedUntil = 0
  constructor(private readonly deps: {
    db: DatabaseSync; todos: Todos; tasks: FeishuTasks; log: Logger; now?: () => number
    /** Shutdown/current deployment boundary; must not include mutable Todo content. */
    assertCurrent?: () => void
    permissionVersion?: () => unknown
    permissionRetryMs?: number
    /** Destructive cancellation requires an explicit product choice. */
    cancellation?: 'delete'
  }) {
    ensureFeishuTaskSyncSchema(deps.db)
    for (const row of deps.db.prepare('SELECT * FROM feishu_task_permission_blocks').all()) {
      if (CAPABILITIES.includes(row.capability as TaskCapability)) this.blocks.set(row.capability as TaskCapability,
        { until: Number(row.until_ms), version: String(row.version), code: Number(row.code), scopes: JSON.parse(String(row.scopes_json)) })
    }
  }
  private get now(): number { return (this.deps.now ?? Date.now)() }
  private current(): void { assertRequestCurrent(); this.deps.assertCurrent?.() }
  resetPermissionBlock(): void { this.blocks.clear(); this.deps.db.exec('DELETE FROM feishu_task_permission_blocks'); this.rateLimitedUntil = 0 }
  private permissionVersion(): string { return createHash('sha256').update(JSON.stringify(this.deps.permissionVersion?.() ?? null)).digest('hex') }
  private clearBlock(capability: TaskCapability): void {
    this.blocks.delete(capability)
    this.deps.db.prepare('DELETE FROM feishu_task_permission_blocks WHERE capability=?').run(capability)
  }
  private async native<T>(capability: TaskCapability, call: () => Promise<T>): Promise<T> {
    const value = await call()
    this.clearBlock(capability)
    return value
  }
  /** Tenant application permissions are distinct from the person's connection.
   * Only scopes, never the provider error body, cross the UI boundary. */
  availability(visible: readonly Todo[] = []): NativeTaskAvailability {
    for (const capability of CAPABILITIES) this.blocked(capability)
    const blockedCapabilities = CAPABILITIES.filter(capability => this.blocks.has(capability))
    const requiredScopes = [...new Set(blockedCapabilities.flatMap(capability => this.blocks.get(capability)!.scopes))]
    const times = visible.flatMap(todo => { const value = this.row(todo.id)?.last_verified_at; return typeof value === 'number' ? [value] : [] })
    const lastSuccessAt = times.length ? Math.max(...times) : null
    const invalidToken = blockedCapabilities.some(capability => this.blocks.get(capability)?.code === 99991663)
    const readFailed = visible.some(todo => this.link(todo.id)?.issue?.reason === 'read_failed')
    const state = blockedCapabilities.length ? 'permission_required' : this.rateLimitedUntil > this.now || readFailed ? 'retrying' : lastSuccessAt === null ? 'not_checked' : 'available'
    return { source: 'feishu_tasks', coverage: 'friday_mirror_only', state, lastSuccessAt, blockedCapabilities, requiredScopes,
      label: state === 'permission_required' ? 'Friday 事项已保留，飞书任务同步缺少应用权限'
        : state === 'retrying' ? this.rateLimitedUntil > this.now ? '飞书任务暂时限流，稍后自动重试' : '部分飞书任务状态暂未核实，稍后自动重试'
        : state === 'not_checked' ? '仅同步 Friday 中已确认的事项，尚无成功同步记录' : '仅同步 Friday 中已确认的事项，不读取你的全部飞书任务',
      nextRetryAt: blockedCapabilities.length ? Math.max(this.now, Math.min(...blockedCapabilities.map(capability => this.blocks.get(capability)!.until)))
        : this.rateLimitedUntil > this.now ? this.rateLimitedUntil : null,
      nextStep: blockedCapabilities.length ? invalidToken ? '请应用管理员检查 Friday 的应用凭据；恢复后会自动重试，无需重复创建事项。'
        : '请应用管理员开通缺少的飞书任务应用权限并发布生效；个人重新连接无法补齐。生效后会自动重试，无需重复创建事项。' : null }
  }
  /** Native Task assignee: the same responsibility rule used by My Day. Unknown owners are never guessed. */
  static audience(todo: Todo): string | undefined {
    return todo.confirmed && todo.status !== 'cancelled' ? responsibleOpenId(todo) ?? undefined : undefined
  }
  static clientToken(todoId: number, generation = 0, operationId = ''): string {
    return createHash('sha256').update(`friday-todo:${todoId}:${generation}:${operationId}`).digest('hex').slice(0, 32)
  }
  link(todoId: number): TaskLink | undefined {
    const r = this.row(todoId)
    return r ? { todoId, guid: String(r.guid), url: r.url == null ? null : String(r.url),
      ownerOpenId: r.owner_open_id == null ? null : String(r.owner_open_id), completedAt: r.completed_at == null ? null : Number(r.completed_at),
      generation: Number(r.generation), deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
      ...(r.issue_json ? { issue: JSON.parse(String(r.issue_json)) as TaskSyncIssue } : {}) } : undefined
  }
  /** Safe status metadata: local save is not proof of a native Task write. */
  status(todoId: number): { link?: TaskLink; pending?: { id: string; kind: Kind; attempts: number }; blockedUntil?: number } {
    const operation = this.pending(todoId), until = this.blockedUntil()
    return { link: this.link(todoId), ...(operation ? { pending: { id: operation.id, kind: operation.kind, attempts: operation.attempts } } : {}),
      ...(until !== undefined ? { blockedUntil: until } : {}) }
  }

  /** The caller has already checked that the viewer may see this Todo. No network call. */
  view(todo: Todo): NativeTaskView {
    const projected = this.project(todo), lastSuccessAt = this.row(todo.id)?.last_verified_at
    const value: NativeTaskView = { ...projected, lastSuccessAt: typeof lastSuccessAt === 'number' ? lastSuccessAt : null }
    if (projected.state === 'permission_required') {
      const availability = this.availability([todo])
      value.requiredScopes = availability.requiredScopes
      if (availability.nextRetryAt !== null) value.retryAt = availability.nextRetryAt
      if (availability.nextStep) value.nextStep = availability.nextStep
    }
    return value
  }
  private project(todo: Todo): NativeTaskView {
    const link = this.link(todo.id), pending = this.pending(todo.id), owner = responsibleOpenId(todo)
    if (!todo.confirmed) return { state: 'not_applicable', label: '候选事项，确认后才会进飞书任务' }
    // A recorded problem outranks an operation in flight: an exhausted transfer step is not “转交中”.
    if (link?.issue && link.deletedAt === null) return issueView(link.issue)
    if (pending) {
      const waiting = this.now - pending.updatedAt >= NATIVE_RETRY_DELAY_MS || link?.issue?.reason === 'unknown_write'
      if (pending.kind === 'add_member' || pending.kind === 'remove_member') return { state: 'transferring', label: '正在把飞书任务转给新负责人' }
      if (waiting) return { state: 'unverified', label: pending.kind === 'create' ? '飞书任务是否已创建还在核对' : '飞书任务的修改结果还在核对',
        ...(link?.issue?.fields ? { fields: link.issue.fields } : {}) }
      return { state: 'syncing', label: pending.kind === 'create' ? '正在创建飞书任务' : pending.kind === 'delete' ? '正在删除飞书任务' : '正在同步到飞书任务' }
    }
    if (!link) {
      if (!owner) return { state: 'owner_unknown', label: '负责人未确认，没有建飞书任务' }
      if (todo.status === 'cancelled') return { state: 'not_applicable', label: '已取消，没有建飞书任务' }
      if (this.rateLimitedUntil > this.now) return { state: 'queued', label: '飞书暂时限流，稍后会自动同步' }
      this.blocked('write')
      if (this.blocks.has('write')) return { state: 'permission_required', label: PERMISSION_LABEL.write!, fields: ['write'] }
      return { state: 'queued', label: '等待同步到飞书任务' }
    }
    const url = link.url ?? undefined
    if (link.deletedAt !== null) {
      return todo.status === 'open' ? { state: 'queued', label: '将重新创建飞书任务' } : { state: 'deleted', label: '飞书任务已删除' }
    }
    if (todo.status === 'cancelled') return { state: 'syncing', label: '已取消，飞书任务会随同步删除' }
    if (!owner) return { state: 'owner_unknown', label: '负责人未确认，已暂停同步飞书任务' }
    if (owner !== link.ownerOpenId) return { state: 'transferring', label: '正在把飞书任务转给新负责人' }
    const base = this.snapshot(todo.id)
    if (!base || !same(base.local, localOf(todo)) || base.statusAt !== todo.statusAt) {
      return { state: 'local_pending', label: '已保存在 Friday，等待同步到飞书任务', ...(url ? { url } : {}) }
    }
    return { state: 'synced', label: '已同步到飞书任务', ...(url ? { url } : {}) }
  }

  private row(todoId: number): Record<string, unknown> | undefined { return this.deps.db.prepare('SELECT * FROM feishu_task_links WHERE todo_id=?').get(todoId) }
  private snapshot(todoId: number): Snapshot | undefined {
    const row = this.row(todoId)
    return row?.snapshot_json ? JSON.parse(String(row.snapshot_json)) as Snapshot : undefined
  }
  /** Confirmed items only. The owner may change (a transfer); the anchor may not. */
  private identity(todo: Todo): Identity | undefined {
    const owner = responsibleOpenId(todo)
    return owner && todo.confirmed ? { ...anchorOf(todo), owner } : undefined
  }
  private currentTodo(todo: Todo, guid?: string): boolean {
    this.current()
    const latest = this.deps.todos.get(todo.id)
    return !!latest && todoTag(latest) === todoTag(todo) && (!guid || this.link(todo.id)?.guid === guid)
  }
  private issue(todoId: number, issue: TaskSyncIssue | null): void {
    this.deps.db.prepare('UPDATE feishu_task_links SET issue_json=?,synced_at=? WHERE todo_id=?').run(issue ? JSON.stringify(issue) : null, this.now, todoId)
  }
  private saveSnapshot(todoId: number, snapshot: Snapshot, task: FeishuTask): void {
    this.deps.db.prepare('UPDATE feishu_task_links SET snapshot_json=?,completed_at=?,url=COALESCE(?,url),synced_at=?,last_verified_at=?,issue_json=NULL WHERE todo_id=?')
      .run(JSON.stringify(snapshot), task.completedAt ?? null, task.url ?? null, this.now, this.now, todoId)
  }
  private pending(todoId: number): Operation | undefined {
    const r = this.deps.db.prepare("SELECT * FROM feishu_task_operations WHERE todo_id=? AND state='started'").get(todoId)
    return r ? { id: String(r.id), todoId, generation: Number(r.generation), kind: r.kind as Kind, payload: JSON.parse(String(r.payload_json)) as WritePayload,
      attempts: Number(r.attempts ?? 1), updatedAt: Number(r.updated_at) } : undefined
  }
  private reserve(todo: Todo, generation: number, kind: Kind, payload: WritePayload): Operation | undefined {
    this.current()
    if (this.pending(todo.id)) return undefined
    const id = randomUUID()
    if (kind === 'create') { payload.marker = `friday-task:${id}`; payload.token = FeishuTaskSync.clientToken(todo.id, generation, id) }
    if (kind === 'add_member') payload.token = FeishuTaskSync.clientToken(todo.id, generation, id)
    this.deps.db.prepare(`INSERT INTO feishu_task_operations(id,todo_id,generation,kind,payload_json,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'started',?,?)`).run(id, todo.id, generation, kind, JSON.stringify(payload), this.now, this.now)
    return { id, todoId: todo.id, generation, kind, payload, attempts: 1, updatedAt: this.now }
  }
  /** Durable before the repeated send: a crash during the retry still counts it. */
  private markAttempt(operation: Operation): void {
    this.deps.db.prepare("UPDATE feishu_task_operations SET attempts=attempts+1,updated_at=? WHERE id=? AND state='started'").run(this.now, operation.id)
  }
  private returned(operation: Operation, receipt: unknown): void {
    // Preserve a real ACK even when the local Todo or host lifetime changed during I/O.
    this.deps.db.prepare("UPDATE feishu_task_operations SET state='returned',result_json=?,updated_at=? WHERE id=? AND state='started'")
      .run(JSON.stringify(receipt), this.now, operation.id)
  }
  private blocked(capability: TaskCapability): boolean {
    if (this.rateLimitedUntil > this.now) return true
    const block = this.blocks.get(capability)
    if (!block) return false
    if (block.version !== this.permissionVersion()) { this.clearBlock(capability); return false }
    if (block.until > this.now) return true
    // Keep the last verified failure visible until a successful probe, even
    // though the cooldown now permits a new attempt.
    return false
  }
  private blockedUntil(): number | undefined {
    const active = CAPABILITIES.filter(capability => this.blocked(capability))
      .map(capability => Math.max(this.rateLimitedUntil, this.blocks.get(capability)?.until ?? 0))
    return active.length ? Math.min(...active) : undefined
  }
  /** true when the failure was a structured rejection that proves the write was not performed. */
  private failed(operation: Operation | undefined, error: unknown, capability: TaskCapability, todoId?: number): boolean {
    const rejected = (code: number) => {
      if (operation) this.deps.db.prepare("UPDATE feishu_task_operations SET state='rejected',error_code=?,updated_at=? WHERE id=? AND state='started'")
        .run(code, this.now, operation.id)
    }
    if (operation && error instanceof FeishuTaskError && error.isResourceDenied) {
      // An explicit object authorization rejection proves that this write was not performed.
      // It does not disable other people's tasks; a later fresh GET can establish recovery.
      rejected(error.code)
      this.issue(operation.todoId, { reason: 'resource_denied' })
      return true
    }
    if (error instanceof FeishuTaskError && error.isRateLimited) {
      rejected(error.code)
      this.rateLimitedUntil = this.now + NATIVE_RATE_LIMIT_WAIT_MS
      this.deps.log.warn('feishu task rate limited', { code: error.code, retryAt: this.rateLimitedUntil })
      return true
    }
    if (error instanceof FeishuTaskError && error.isRejectedRequest) {
      // Refused as sent (bad parameters, member limits). Re-planned from current state; never counted as unknown.
      rejected(error.code)
      const affected = operation?.todoId ?? todoId
      if (affected !== undefined && this.row(affected)) this.issue(affected, { reason: 'request_rejected', fields: [operation?.kind ?? capability], code: error.code })
      this.deps.log.warn('feishu task request rejected', { todoId: affected, operation: operation?.kind, code: error.code })
      return true
    }
    if (error instanceof FeishuTaskError && error.isPermission) {
      rejected(error.code)
      const until = this.now + Math.max(1_000, this.deps.permissionRetryMs ?? 5 * 60_000), version = this.permissionVersion()
      const scopes = [...new Set(error.detail.match(/\btask:[a-z_]+:[a-z_]+\b/g) ?? [])].slice(0, 20)
      // A missing scope stops only the calls that need it. An invalid app token stops every call.
      for (const blocked of error.blocksAllCapabilities ? CAPABILITIES : [capability]) {
        this.blocks.set(blocked, { until, version, code: error.code, scopes })
        this.deps.db.prepare(`INSERT INTO feishu_task_permission_blocks VALUES(?,?,?,?,?) ON CONFLICT(capability)
          DO UPDATE SET until_ms=excluded.until_ms,version=excluded.version,code=excluded.code,scopes_json=excluded.scopes_json`)
          .run(blocked, until, version, error.code, JSON.stringify(scopes))
      }
      const affected = operation?.todoId ?? todoId
      if (affected !== undefined && this.row(affected)) this.issue(affected, { reason: 'permission_required', fields: [capability] })
      this.deps.log.warn('feishu task permission unavailable', { code: error.code, capability: error.blocksAllCapabilities ? 'all' : capability, retryAt: until })
      return true
    }
    this.deps.log.warn('feishu task synchronization incomplete', { todoId: operation?.todoId ?? todoId, operation: operation?.kind,
      code: error instanceof FeishuTaskError ? error.code : undefined, outcome: operation ? 'unknown' : 'read_failed' })
    return false
  }
  sweep(limit = 30): Promise<TaskSyncResult> {
    if (this.active) return this.active
    const run = this.runSweep(limit)
    this.active = run
    void run.finally(() => { if (this.active === run) this.active = undefined }).catch(() => {})
    return run
  }
  private async runSweep(limit: number): Promise<TaskSyncResult> {
    const out: TaskSyncResult = { created: 0, completed: 0, pulledBack: 0, skipped: 0, updated: 0, reopened: 0, cancelled: 0, conflicts: 0, unknown: 0, transferred: 0, retried: 0 }
    this.current()
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('同步数量必须是非负整数')
    if (!limit) return out
    // Done tasks also need polling: people can reopen them. Oldest observations get a fair turn.
    if (!this.blocked('read')) {
      const linked = this.deps.db.prepare('SELECT todo_id FROM feishu_task_links ORDER BY synced_at ASC,todo_id ASC LIMIT ?').all(limit)
      for (const row of linked) {
        this.current()
        const todo = this.deps.todos.get(Number(row.todo_id)), link = this.link(Number(row.todo_id))!
        if (!todo) { this.issue(link.todoId, { reason: 'identity_changed' }); out.skipped++; continue }
        try { await this.syncLinked(todo, link, out) }
        catch (error) {
          if (this.failed(undefined, error, 'read', todo.id)) { if (this.blocked('read')) break; continue }
          this.issue(todo.id, { reason: error instanceof FeishuTaskError && error.isResourceDenied ? 'resource_denied'
            : error instanceof FeishuTaskError && error.isNotFound ? 'remote_missing' : 'read_failed' })
          out.skipped++
        }
        this.current()
      }
    }
    out.unknown += Number(this.deps.db.prepare(`SELECT count(*) AS n FROM feishu_task_operations o WHERE o.kind='create' AND o.state='started'
      AND NOT EXISTS (SELECT 1 FROM feishu_task_links l WHERE l.todo_id=o.todo_id)`).get()?.n ?? 0)
    if (!this.blocked('write')) {
      // Only items with a determinable responsible person: an explicit open_id, or an unnamed owner in
      // that person's own private chat. Unknown owners never occupy creation slots.
      const pending = this.deps.db.prepare(`SELECT t.id FROM todos t WHERE t.confirmed=1 AND t.status!='cancelled'
        AND (t.owner_open_id IS NOT NULL OR (t.owner IS NULL AND (t.scope LIKE 'space:sp\\_dm\\_%' ESCAPE '\\' OR t.scope LIKE 'user:%')))
        AND NOT EXISTS (SELECT 1 FROM feishu_task_links l WHERE l.todo_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM feishu_task_operations o WHERE o.todo_id=t.id AND o.state='started')
        ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).all(limit)
      for (const row of pending) {
        this.current()
        const todo = this.deps.todos.get(Number(row.id))
        if (!todo || this.link(todo.id)) continue
        await this.create(todo, 0, out)
        if (this.blocked('write')) break
      }
    }
    const blocked = CAPABILITIES.filter(capability => this.blocked(capability))
    return blocked.length ? { ...out, blocked: true, retryAt: this.blockedUntil(), blockedCapabilities: blocked } : out
  }
  private async create(todo: Todo, generation: number, out: TaskSyncResult): Promise<void> {
    const identity = this.identity(todo)
    if (!identity || todo.status === 'cancelled') { out.skipped++; return }
    if (this.pending(todo.id)) { out.unknown++; return }
    const local = localOf(todo)
    const snapshot: Snapshot = { identity, local, remote: local, statusAt: todo.statusAt, remoteAllDay: false }
    const operation = this.reserve(todo, generation, 'create', { snapshot, localTag: todoTag(todo) })
    if (!operation) { out.skipped++; return }
    try {
      const task = await this.native('write', () => this.deps.tasks.create({ summary: local.summary, description: local.description ?? undefined,
        dueMs: local.dueMs, completedAtMs: local.done ? todo.doneAt ?? this.now : undefined,
        assigneeOpenIds: [identity.owner], clientToken: operation.payload.token!, extra: operation.payload.marker }))
      this.acceptCreate(operation, task); out.created++
    } catch (error) { if (!this.failed(operation, error, 'write')) out.unknown++ }
    this.current()
  }
  private acceptCreate(operation: Operation, task: FeishuTask): void {
    const remote = remoteOf(task), snapshot = { ...operation.payload.snapshot, local: remote, remote, remoteAllDay: task.dueIsAllDay === true }
    this.deps.db.exec('SAVEPOINT feishu_task_create_ack')
    try {
      this.returned(operation, { source: 'provider', task })
      this.deps.db.prepare(`INSERT INTO feishu_task_links(todo_id,guid,url,owner_open_id,created_at,synced_at,completed_at,snapshot_json,generation)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(todo_id) DO UPDATE SET guid=excluded.guid,url=excluded.url,owner_open_id=excluded.owner_open_id,
          synced_at=excluded.synced_at,completed_at=excluded.completed_at,snapshot_json=excluded.snapshot_json,generation=excluded.generation,deleted_at=NULL,issue_json=NULL`)
        .run(operation.todoId, task.guid, task.url ?? null, snapshot.identity.owner, this.now, this.now, task.completedAt ?? null, JSON.stringify(snapshot), operation.generation)
      this.deps.db.prepare('UPDATE feishu_task_links SET last_verified_at=? WHERE todo_id=?').run(this.now, operation.todoId)
      this.deps.db.exec('RELEASE feishu_task_create_ack')
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_create_ack; RELEASE feishu_task_create_ack'); throw error }
  }
  /** Exact GUID reconciliation needs the host's current Todo audience guard. The task must carry
   * our reserved marker and original assignee; it cannot grant access or cause a second POST.
   * A later owner change is handled afterwards as an ordinary transfer. */
  async reconcileCreation(todoId: number, guid: string, assertCurrent: () => void = () => {}): Promise<boolean> {
    this.current(); assertCurrent()
    const operation = this.pending(todoId), todo = this.deps.todos.get(todoId)
    if (!operation || operation.kind !== 'create' || !todo || !todo.confirmed || !same(anchorOf(todo), anchorOf(operation.payload.snapshot.identity))) return false
    let task: FeishuTask
    try { task = await this.native('read', () => this.deps.tasks.get(guid)) }
    finally { this.current(); assertCurrent() }
    if (!this.currentTodo(todo) || this.pending(todoId)?.id !== operation.id) return false
    if (task.guid !== guid || task.extra !== operation.payload.marker || !same(assigneesOf(task), [operation.payload.snapshot.identity.owner])) return false
    if (this.deps.db.prepare('SELECT todo_id FROM feishu_task_links WHERE guid=? AND todo_id!=?').get(guid, todoId)) return false
    assertCurrent(); this.acceptCreate(operation, task)
    return true
  }
  /** A person states that an unknown creation did not produce a task. This is their decision, not a
   * blind replay: the old operation is kept as abandoned and the next sweep may create a new task. */
  abandonCreation(todoId: number, assertCurrent: () => void = () => {}): boolean {
    this.current(); assertCurrent()
    const operation = this.pending(todoId), link = this.link(todoId)
    // A re-creation after an explicit reopen keeps the previous generation's deleted link row.
    if (!operation || operation.kind !== 'create' || (link && link.deletedAt === null)) return false
    assertCurrent()
    return Number(this.deps.db.prepare("UPDATE feishu_task_operations SET state='abandoned',result_json=?,updated_at=? WHERE id=? AND state='started'")
      .run(JSON.stringify({ abandoned: true, decidedBy: 'person', at: this.now }), this.now, operation.id).changes) > 0
  }

  private async syncLinked(todo: Todo, link: TaskLink, out: TaskSyncResult): Promise<void> {
    let base = this.snapshot(todo.id)
    if (!todo.confirmed || (base && !same(anchorOf(base.identity), anchorOf(todo)))) {
      this.issue(todo.id, { reason: 'identity_changed' }); out.skipped++; return
    }
    if (link.deletedAt !== null) {
      if (this.pending(todo.id)) {
        // An unknown re-creation is never POSTed again; a person reconciles or abandons it. Recording the issue
        // also moves this row to the back of the linked queue so it cannot starve other items.
        this.issue(todo.id, { reason: 'unknown_write', fields: ['create'] }); out.unknown++; return
      }
      const active = ['open', 'blocked', 'review'].includes(todo.status)
      if (active && base?.deletion && (base.deletion.recreate || (todo.status === 'open' && (base.deletion.status !== 'open' || todo.statusAt !== base.deletion.statusAt)))) {
        if (!this.blocked('write')) await this.create(todo, link.generation + 1, out)
      } else this.issue(todo.id, null)
      return
    }
    // Deleting the exact linked task needs no current owner; every other native write does.
    const owner = todo.status === 'cancelled' ? link.ownerOpenId ?? responsibleOpenId(todo) : responsibleOpenId(todo)
    if (!owner) { this.issue(todo.id, { reason: 'owner_unknown' }); out.skipped++; return }
    if (todo.status === 'cancelled' && !this.deps.cancellation) {
      this.issue(todo.id, { reason: 'cancellation_policy_required' }); out.skipped++; return
    }
    let remoteTask: FeishuTask
    try { remoteTask = await this.native('read', () => this.deps.tasks.get(link.guid)) }
    catch (error) {
      // GET's 1470404 is explicit absence of this exact previously acknowledged GUID. A generic
      // 404, lost socket or 1470403 resource denial cannot satisfy this proof.
      if (!(error instanceof FeishuTaskError && error.isNotFound) || !this.currentTodo(todo, link.guid)) throw error
      let pending = this.pending(todo.id)
      if (pending && pending.kind !== 'delete') {
        // The target no longer exists, so the unresolved write cannot land anywhere: close it with this readback.
        this.returned(pending, { source: 'readback', deleted: true, guid: link.guid, code: error.code })
        pending = undefined
      }
      if (pending?.kind === 'delete' || todo.status === 'cancelled' || (base && same(base.local, localOf(todo)) && base.statusAt === todo.statusAt)) {
        this.acceptDelete(todo.id, link.guid, pending, { source: 'readback', deleted: true, guid: link.guid, code: error.code }, !pending)
        out.cancelled++; return
      }
      // Deleted in Feishu while Friday holds newer content: a person chooses to recreate it or cancel locally.
      this.issue(todo.id, { reason: 'remote_missing' }); out.conflicts++; return
    }
    if (!this.currentTodo(todo, link.guid)) { out.skipped++; return }
    if (remoteTask.guid !== link.guid) { this.issue(todo.id, { reason: 'identity_changed' }); out.skipped++; return }
    this.deps.db.prepare('UPDATE feishu_task_links SET last_verified_at=? WHERE todo_id=?').run(this.now, todo.id)
    const pending = this.pending(todo.id)
    if (pending) {
      const settled = await this.settle(pending, todo, link, remoteTask, out)
      if (!settled || !this.currentTodo(todo, link.guid)) return
      remoteTask = settled
      link = this.link(todo.id)!
      base = this.snapshot(todo.id)
    }
    // D3: one native task follows the Todo to its new responsible person. Deletion ignores assignees entirely.
    const assignees = assigneesOf(remoteTask)
    if (assignees && todo.status !== 'cancelled' && owner !== link.ownerOpenId) { await this.transfer(todo, link, owner, remoteTask, out); return }
    if (assignees && todo.status !== 'cancelled' && !same(assignees, [owner])) {
      // Extra assignees that Friday itself added in an unfinished transfer are finished off; any other change was
      // made directly in Feishu, and Friday neither guesses the new owner nor silently undoes it.
      const ours = new Set(base?.transfer?.ours ?? [])
      if (assignees.includes(owner) && assignees.every(id => id === owner || ours.has(id))) { await this.transfer(todo, link, owner, remoteTask, out); return }
      this.issue(todo.id, { reason: 'conflict', fields: ['owner'] }); out.conflicts++; return
    }
    const identity: Identity = { ...anchorOf(todo), owner }
    const localNow = localOf(todo), remoteNow = remoteOf(remoteTask)
    // Content Friday cannot store is only a problem when it would have to be taken into Friday.
    const invalid = new Set<Field>([
      ...(!remoteNow.summary || remoteNow.summary.length > 200 ? ['summary' as const] : []),
      ...((remoteNow.description?.length ?? 0) > 2000 ? ['description' as const] : []),
      ...(remoteNow.dueMs !== null && (!Number.isSafeInteger(remoteNow.dueMs) || remoteNow.dueMs < 0) ? ['dueMs' as const] : []),
    ])
    // Legacy rows cannot tell which side changed. Establish a baseline only when both agree.
    if (!base) {
      if (!same(localNow, remoteNow)) { this.issue(todo.id, { reason: 'legacy_conflict' }); out.conflicts++; return }
      base = { identity, local: localNow, remote: remoteNow, statusAt: todo.statusAt, remoteAllDay: remoteTask.dueIsAllDay === true }
      this.saveSnapshot(todo.id, base, remoteTask)
    }
    if (todo.status === 'cancelled') {
      if (this.deps.cancellation !== 'delete') { this.issue(todo.id, { reason: 'cancellation_policy_required' }); out.skipped++; return }
      if (!same(base.remote, remoteNow) || base.remoteAllDay !== (remoteTask.dueIsAllDay === true)) {
        this.issue(todo.id, { reason: 'conflict', fields: ['cancel'] }); out.conflicts++; return
      }
      if (this.blocked('delete')) { this.issue(todo.id, { reason: 'permission_required', fields: ['delete'] }); out.skipped++; return }
      const operation = this.reserve(todo, link.generation, 'delete', { snapshot: { ...base, identity,
        deletion: { status: todo.status, statusAt: todo.statusAt, source: 'provider' } }, localTag: todoTag(todo), guid: link.guid })
      if (!operation) { out.unknown++; return }
      await this.sendDelete(operation, todo.id, link.guid, out)
      return
    }
    const push: Field[] = [], pull: Field[] = [], conflicts: Field[] = []
    for (const field of fields) {
      const localChanged = !same(localNow[field], base.local[field]) || (field === 'done' && todo.statusAt !== base.statusAt)
      const remoteChanged = !same(remoteNow[field], base.remote[field]) || (field === 'dueMs' && (remoteTask.dueIsAllDay === true) !== base.remoteAllDay)
      if (same(localNow[field], remoteNow[field])) continue
      if (localChanged && !remoteChanged) push.push(field)
      else if (remoteChanged && !localChanged) pull.push(field)
      else conflicts.push(field)
    }
    if (conflicts.length) { this.issue(todo.id, { reason: 'conflict', fields: conflicts }); out.conflicts++; return }
    if (pull.some(field => invalid.has(field))) { this.issue(todo.id, { reason: 'invalid_remote' }); out.conflicts++; return }
    if (pull.length) { this.pull(todo, remoteTask, pull); todo = this.deps.todos.get(todo.id)!; out.pulledBack++ }
    const mergedLocal = localOf(todo)
    const next: Snapshot = { identity, local: { ...mergedLocal }, remote: { ...remoteNow }, statusAt: todo.statusAt, remoteAllDay: remoteTask.dueIsAllDay === true }
    // Preserve the unperformed local delta until its own write is acknowledged.
    for (const field of push) { Object.assign(next.local, { [field]: base.local[field] }); if (field === 'done') next.statusAt = base.statusAt }
    this.saveSnapshot(todo.id, next, remoteTask)
    if (!push.length) return
    if (this.blocked('write')) { this.issue(todo.id, { reason: 'permission_required', fields: ['write'] }); out.skipped++; return }
    const patch: PatchTaskInput = {}
    if (push.includes('summary')) patch.summary = mergedLocal.summary
    if (push.includes('description')) patch.description = mergedLocal.description
    if (push.includes('dueMs')) patch.dueMs = mergedLocal.dueMs
    if (push.includes('done')) patch.completedAtMs = mergedLocal.done ? todo.doneAt ?? this.now : 0
    const operation = this.reserve(todo, link.generation, 'patch', { snapshot: { ...next, local: mergedLocal, statusAt: todo.statusAt }, localTag: todoTag(todo), guid: link.guid, patch, fields: push })
    if (!operation) { out.unknown++; return }
    await this.sendPatch(operation, todo.id, link.guid, out)
  }

  private async sendPatch(operation: Operation, todoId: number, guid: string, out: TaskSyncResult): Promise<FeishuTask | undefined> {
    const push = operation.payload.fields ?? [], target = operation.payload.snapshot.local
    try {
      const task = await this.native('write', () => this.deps.tasks.patch(guid, operation.payload.patch ?? {}))
      // Only requested fields advance. Unrelated human edits in the ACK remain changes to pull.
      if (task.guid === guid && push.every(field => same(remoteOf(task)[field], target[field]))) {
        this.acceptPatch(operation, task, 'provider'); out.updated++
        if (push.includes('done')) { if (target.done) out.completed++; else out.reopened++ }
        return task
      }
      // An inconsistent success response is retained without allowing a second write.
      this.deps.db.prepare("UPDATE feishu_task_operations SET result_json=?,updated_at=? WHERE id=? AND state='started'")
        .run(JSON.stringify({ source: 'provider', task, verified: false }), this.now, operation.id)
      this.issue(todoId, { reason: 'unknown_write', fields: push }); out.unknown++
    } catch (error) {
      // 1470404 for this exact GUID: the task is gone, so the write cannot land. The next GET decides what that means.
      if (error instanceof FeishuTaskError && error.isNotFound) { this.returned(operation, { source: 'provider', deleted: true, guid, code: error.code }); return undefined }
      if (!this.failed(operation, error, 'write')) out.unknown++
    }
    return undefined
  }
  private async sendDelete(operation: Operation, todoId: number, guid: string, out: TaskSyncResult): Promise<void> {
    try {
      await this.native('delete', () => this.deps.tasks.delete(guid))
      this.acceptDelete(todoId, guid, operation, { source: 'provider', deleted: true, guid })
      out.cancelled++
    } catch (error) {
      // The official absence code for this exact GUID proves the task no longer exists.
      if (error instanceof FeishuTaskError && error.isNotFound) {
        this.acceptDelete(todoId, guid, operation, { source: 'provider', deleted: true, guid, code: error.code }); out.cancelled++; return
      }
      if (!this.failed(operation, error, 'delete')) out.unknown++
    }
  }

  /**
   * D3 transfer on the same native task: add the new assignee, then remove the previous owner and any
   * assignee Friday itself added earlier in an unfinished transfer. Each step has its own receipt and
   * readback; existing/absent members are ignored by the platform, so repeating a step is harmless.
   * Only when the task has exactly the new assignee is the link moved; until then the item is “转交中”.
   */
  private async transfer(todo: Todo, link: TaskLink, owner: string, task: FeishuTask, out: TaskSyncResult): Promise<void> {
    const from = link.ownerOpenId, assignees = assigneesOf(task) ?? [], base = this.snapshot(todo.id)
    const ours = new Set([...(from ? [from] : []), ...(base?.transfer?.ours ?? [])])
    if (same(assignees, [owner])) { this.acceptTransfer(undefined, todo.id, owner, task); out.transferred++; return }
    if (!assignees.every(id => id === owner || ours.has(id))) { this.issue(todo.id, { reason: 'conflict', fields: ['owner'] }); out.conflicts++; return }
    if (this.blocked('members')) { this.issue(todo.id, { reason: 'permission_required', fields: ['members'] }); out.skipped++; return }
    const payload = (removed?: string): WritePayload => ({ snapshot: base ?? { identity: { ...anchorOf(todo), owner: from ?? owner }, local: localOf(todo), remote: remoteOf(task),
      statusAt: todo.statusAt, remoteAllDay: task.dueIsAllDay === true }, localTag: todoTag(todo), guid: link.guid,
      ...(removed ?? from ? { from: removed ?? from! } : {}), to: owner })
    let current = task
    if (!assignees.includes(owner)) {
      const operation = this.reserve(todo, link.generation, 'add_member', payload())
      if (!operation) { out.unknown++; return }
      const added = await this.sendMember(operation, out)
      if (!added || !this.currentTodo(todo, link.guid)) return
      current = added
    }
    for (const extra of (assigneesOf(current) ?? []).filter(id => id !== owner && ours.has(id))) {
      const operation = this.reserve(todo, link.generation, 'remove_member', payload(extra))
      if (!operation) { out.unknown++; return }
      const removed = await this.sendMember(operation, out)
      if (!removed || !this.currentTodo(todo, link.guid)) return
      current = removed
    }
    if (same(assigneesOf(current), [owner])) { this.acceptTransfer(undefined, todo.id, owner, current); out.transferred++ }
  }
  /** Returns the acknowledged task when the requested member change is visible in the ACK. */
  private async sendMember(operation: Operation, out: TaskSyncResult): Promise<FeishuTask | undefined> {
    const { guid, from, to } = operation.payload
    try {
      const task = operation.kind === 'add_member'
        ? await this.native('members', () => this.deps.tasks.addAssignees(guid!, [to!], operation.payload.token))
        : await this.native('members', () => this.deps.tasks.removeAssignees(guid!, [from!]))
      const assignees = assigneesOf(task) ?? []
      const reached = operation.kind === 'add_member' ? assignees.includes(to!) : !assignees.includes(from!)
      if (operation.kind === 'add_member') this.noteOurs(operation.todoId, to!)
      if (task.guid !== guid || !reached) {
        this.deps.db.prepare("UPDATE feishu_task_operations SET result_json=?,updated_at=? WHERE id=? AND state='started'")
          .run(JSON.stringify({ source: 'provider', task, verified: false }), this.now, operation.id)
        this.issue(operation.todoId, { reason: 'unknown_write', fields: ['owner'] }); out.unknown++
        return undefined
      }
      this.returned(operation, { source: 'provider', task })
      return task
    } catch (error) {
      // Adding may land later even when the answer was lost: remember that the person may be ours to remove.
      if (operation.kind === 'add_member') this.noteOurs(operation.todoId, to!)
      if (error instanceof FeishuTaskError && error.isNotFound) {
        this.returned(operation, { source: 'provider', deleted: true, guid, code: error.code }); return undefined
      }
      if (!this.failed(operation, error, 'members')) out.unknown++
    }
    return undefined
  }
  private acceptTransfer(operation: Operation | undefined, todoId: number, owner: string, task: FeishuTask, source: 'provider' | 'readback' = 'provider'): void {
    this.deps.db.exec('SAVEPOINT feishu_task_transfer_ack')
    try {
      if (operation) this.returned(operation, { source, task })
      const snapshot = this.snapshot(todoId)
      if (snapshot) { snapshot.identity = { ...snapshot.identity, owner }; delete snapshot.transfer }
      this.deps.db.prepare('UPDATE feishu_task_links SET owner_open_id=?,snapshot_json=COALESCE(?,snapshot_json),synced_at=?,issue_json=NULL WHERE todo_id=?')
        .run(owner, snapshot ? JSON.stringify(snapshot) : null, this.now, todoId)
      this.deps.db.exec('RELEASE feishu_task_transfer_ack')
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_transfer_ack; RELEASE feishu_task_transfer_ack'); throw error }
  }
  /** Record an assignee that Friday added (or may have added) in an unfinished transfer. */
  private noteOurs(todoId: number, openId: string): void {
    const snapshot = this.snapshot(todoId)
    if (!snapshot) return
    const ours = [...new Set([...(snapshot.transfer?.ours ?? []), openId])]
    this.deps.db.prepare('UPDATE feishu_task_links SET snapshot_json=? WHERE todo_id=?').run(JSON.stringify({ ...snapshot, transfer: { ours } }), todoId)
  }
  /** A superseded or person-decided operation stays on record with why it ended. */
  private abandon(operation: Operation, reason: string, extra: Record<string, unknown> = {}): void {
    this.deps.db.prepare("UPDATE feishu_task_operations SET state='abandoned',result_json=?,updated_at=? WHERE id=? AND state='started'")
      .run(JSON.stringify({ abandoned: true, reason, ...extra }), this.now, operation.id)
  }

  /**
   * D4 for a started (unknown-outcome) write, after a fresh GET of the same GUID:
   * - the readback already shows the requested result → confirm it; no further write;
   * - the remote is still at the value observed before the request, the local intent is unchanged and
   *   repeating the same request is harmless → bounded retry on the same operation row;
   * - a member step whose intent changed (owner changed again, or the item was cancelled) is superseded:
   *   member steps commute, and anything it may have added stays removable as “ours”;
   * - otherwise (someone changed the task, the local intent changed, attempts exhausted) → wait for a
   *   later readback or a person. A newer local decision is never written over an unresolved request.
   * Returns the latest acknowledged task to continue with, or undefined to stop this item for now.
   */
  private async settle(operation: Operation, todo: Todo, link: TaskLink, task: FeishuTask, out: TaskSyncResult): Promise<FeishuTask | undefined> {
    const payload = operation.payload, remote = remoteOf(task), local = localOf(todo), assignees = assigneesOf(task) ?? []
    const push = payload.fields ?? []
    let reached = false, repeatable = false, issueFields: readonly string[] = push
    switch (operation.kind) {
      case 'patch':
        reached = push.every(field => same(remote[field], payload.snapshot.local[field]))
        repeatable = push.every(field => same(remote[field], payload.snapshot.remote[field]) && same(local[field], payload.snapshot.local[field]))
          && (!push.includes('done') || todo.statusAt === payload.snapshot.statusAt)
        break
      case 'delete':
        // A task that still exists was not (yet) deleted; deletion is proven only by 1470404.
        repeatable = todo.status === 'cancelled' && todo.statusAt === payload.snapshot.deletion?.statusAt && same(remote, payload.snapshot.remote)
        issueFields = ['cancel']
        break
      case 'add_member':
      case 'remove_member': {
        reached = operation.kind === 'add_member' ? assignees.includes(payload.to!) : !assignees.includes(payload.from!)
        if (operation.kind === 'add_member' && reached) this.noteOurs(todo.id, payload.to!)
        if (!reached && (todo.status === 'cancelled' || responsibleOpenId(todo) !== payload.to)) {
          if (operation.kind === 'add_member') this.noteOurs(todo.id, payload.to!)
          this.abandon(operation, 'superseded', { observed: task }); return task
        }
        repeatable = operation.kind === 'add_member' || assignees.includes(payload.to!)
        issueFields = ['owner']
        break
      }
      case 'create':
        return undefined
    }
    if (reached) {
      if (operation.kind === 'patch') this.acceptPatch(operation, task, 'readback')
      else this.returned(operation, { source: 'readback', task })
      return task
    }
    const sameTarget = operation.generation === link.generation && payload.guid === link.guid
    if (!repeatable || !sameTarget || operation.attempts >= MAX_NATIVE_ATTEMPTS) {
      this.issue(todo.id, { reason: 'unknown_write', fields: issueFields }); out.unknown++; return undefined
    }
    if (this.now - operation.updatedAt < NATIVE_RETRY_DELAY_MS) { out.unknown++; return undefined }
    const capability = capabilityOf(operation.kind)
    if (this.blocked(capability)) { this.issue(todo.id, { reason: 'permission_required', fields: [capability] }); out.skipped++; return undefined }
    this.markAttempt(operation); out.retried++
    const retry = { ...operation, attempts: operation.attempts + 1 }
    if (operation.kind === 'patch') return this.sendPatch(retry, todo.id, link.guid, out)
    if (operation.kind === 'delete') { await this.sendDelete(retry, todo.id, link.guid, out); return undefined }
    return this.sendMember(retry, out)
  }

  private acceptDelete(todoId: number, guid: string, operation: Operation | undefined,
    receipt: { source: 'provider' | 'readback'; deleted: true; guid: string; code?: number }, cancelLocal = false): void {
    this.deps.db.exec('SAVEPOINT feishu_task_delete_ack')
    try {
      if (operation) this.returned(operation, receipt)
      let todo = this.deps.todos.get(todoId)
      if (cancelLocal && todo && ['open', 'blocked', 'review'].includes(todo.status)) {
        todo = this.deps.todos.transition(todoId, todo.scope, 'cancelled', { note: '在飞书任务里删除', now: this.now })!
      }
      const snapshot = this.snapshot(todoId)
      if (snapshot) {
        const original = operation?.payload.snapshot.deletion
        snapshot.deletion = { status: original?.status ?? todo?.status ?? 'cancelled', statusAt: original?.statusAt ?? todo?.statusAt ?? null, source: receipt.source }
      }
      this.deps.db.prepare('UPDATE feishu_task_links SET deleted_at=?,synced_at=?,last_verified_at=?,snapshot_json=?,issue_json=NULL WHERE todo_id=? AND guid=?')
        .run(this.now, this.now, this.now, snapshot ? JSON.stringify(snapshot) : null, todoId, guid)
      this.deps.db.exec('RELEASE feishu_task_delete_ack')
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_delete_ack; RELEASE feishu_task_delete_ack'); throw error }
  }
  private acceptPatch(operation: Operation, task: FeishuTask, source: 'provider' | 'readback'): Snapshot {
    const next = this.advancePatched(operation, task)
    this.deps.db.exec('SAVEPOINT feishu_task_patch_ack')
    try {
      this.returned(operation, { source, task })
      this.saveSnapshot(operation.todoId, next, task)
      this.deps.db.exec('RELEASE feishu_task_patch_ack')
      return next
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_patch_ack; RELEASE feishu_task_patch_ack'); throw error }
  }
  private advancePatched(operation: Operation, task: FeishuTask): Snapshot {
    const base = this.snapshot(operation.todoId) ?? operation.payload.snapshot
    const next: Snapshot = { ...base, local: { ...base.local }, remote: { ...base.remote } }
    for (const field of operation.payload.fields ?? []) {
      Object.assign(next.local, { [field]: operation.payload.snapshot.local[field] })
      Object.assign(next.remote, { [field]: remoteOf(task)[field] })
      if (field === 'done') next.statusAt = operation.payload.snapshot.statusAt
      if (field === 'dueMs') next.remoteAllDay = task.dueIsAllDay === true
    }
    return next
  }
  private pull(todo: Todo, remote: FeishuTask, changed: readonly Field[]): void {
    if (!this.currentTodo(todo, remote.guid)) throw new Error('本地待办已经变化')
    // Replicate an edit to the exact linked object; retain its scope/owner/provenance/confirmation.
    // Status still goes through the Todo transition table, including done -> open.
    const sets: string[] = [], values: (string | number | null)[] = []
    if (changed.includes('summary')) { sets.push('title=?'); values.push(remote.summary) }
    if (changed.includes('description')) { sets.push('detail=?'); values.push(remote.description || null) }
    if (changed.includes('dueMs')) { sets.push('due_ms=?', "reminded_stages='[]'", 'reminded_at=NULL'); values.push(remote.dueMs ?? null) }
    this.deps.db.exec('SAVEPOINT feishu_task_pull')
    try {
      if (sets.length) this.deps.db.prepare(`UPDATE todos SET ${sets.join(',')} WHERE id=? AND scope=?`).run(...values, todo.id, todo.scope)
      if (changed.includes('done')) {
        const status = remote.completedAt ? 'done' : 'open'
        if (todo.status !== status && !this.deps.todos.transition(todo.id, todo.scope, status, {
          by: todo.ownerOpenId ?? undefined, note: status === 'done' ? '在飞书任务里完成' : '在飞书任务里重新打开', now: remote.completedAt ?? this.now,
        })) throw new Error('本地待办状态不能接收这次同步')
      }
      this.deps.db.exec('RELEASE feishu_task_pull')
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_pull; RELEASE feishu_task_pull'); throw error }
  }

  /**
   * A person decides a conflict or an unresolved write: 'friday' makes Friday's current content the
   * change to send; 'feishu' makes Feishu's current content the change to take. The unresolved request
   * stays on record as abandoned; nothing is sent here. If the task was deleted in Feishu, 'feishu'
   * accepts the deletion (the item is cancelled locally) and 'friday' asks the next sweep for a new task.
   * For a cancel conflict, 'feishu' keeps the Feishu task and reopens the item. Owner conflicts need
   * exactly one Feishu assignee. The caller must have checked that this person may decide for this Todo.
   */
  async resolveConflict(todoId: number, keep: 'friday' | 'feishu', assertCurrent: () => void = () => {}): Promise<boolean> {
    if (keep !== 'friday' && keep !== 'feishu') throw new Error('只能选择以 Friday 或飞书为准')
    this.current(); assertCurrent()
    if (this.active) await this.active.catch(() => undefined)
    this.current(); assertCurrent()
    const todo = this.deps.todos.get(todoId), link = this.link(todoId), operation = this.pending(todoId)
    if (!todo || !todo.confirmed || !link || link.deletedAt !== null || (operation && operation.kind === 'create')) return false
    const reason = link.issue?.reason
    if (!operation && !['conflict', 'legacy_conflict', 'unknown_write', 'invalid_remote', 'remote_missing'].includes(reason ?? '')) return false
    let task: FeishuTask
    try { task = await this.native('read', () => this.deps.tasks.get(link.guid)) }
    catch (error) {
      this.current(); assertCurrent()
      if (!(error instanceof FeishuTaskError && error.isNotFound)) throw error
      if (!this.currentTodo(todo, link.guid) || this.pending(todoId)?.id !== operation?.id) return false
      this.resolveDeleted(todo, link, operation, keep, error.code)
      return true
    }
    this.current(); assertCurrent()
    if (!this.currentTodo(todo, link.guid) || this.pending(todoId)?.id !== operation?.id) return false
    const owner = responsibleOpenId(todo) ?? (todo.status === 'cancelled' ? link.ownerOpenId : null)
    if (!owner) return false
    const remote = remoteOf(task), assignees = assigneesOf(task) ?? []
    if (keep === 'feishu' && (!remote.summary || remote.summary.length > 200 || (remote.description?.length ?? 0) > 2000)) return false
    const ownerConflict = link.issue?.fields?.includes('owner') || operation?.kind === 'add_member' || operation?.kind === 'remove_member'
    if (ownerConflict && assignees.length !== 1) return false
    assertCurrent(); this.deps.db.exec('SAVEPOINT feishu_task_resolve')
    try {
      if (operation) this.abandon(operation, 'decided_by_person', { keep, observed: task })
      let nativeOwner = link.ownerOpenId ?? owner
      if (ownerConflict) {
        nativeOwner = assignees[0]!
        if (keep === 'feishu' && nativeOwner !== owner && !this.deps.todos.update(todo.id, todo.scope, { ownerOpenId: nativeOwner, owner: null })) throw new Error('本地待办不能接收负责人')
      }
      // Keeping Feishu's version of a task Friday had cancelled means the task stays: reopen the item.
      if (keep === 'feishu' && todo.status === 'cancelled' && !this.deps.todos.transition(todo.id, todo.scope, 'open', { note: '以飞书为准，保留飞书任务', now: this.now })) {
        throw new Error('本地待办不能重开')
      }
      const latest = this.deps.todos.get(todo.id)!
      const baseline = keep === 'friday' ? remote : localOf(latest)
      this.deps.db.prepare('UPDATE feishu_task_links SET owner_open_id=? WHERE todo_id=?').run(nativeOwner, todo.id)
      this.saveSnapshot(todo.id, { identity: { ...anchorOf(latest), owner: nativeOwner }, local: baseline, remote: baseline,
        statusAt: latest.statusAt, remoteAllDay: task.dueIsAllDay === true }, task)
      this.deps.db.exec('RELEASE feishu_task_resolve')
      return true
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_resolve; RELEASE feishu_task_resolve'); throw error }
  }

  private resolveDeleted(todo: Todo, link: TaskLink, operation: Operation | undefined, keep: 'friday' | 'feishu', code: number): void {
    this.deps.db.exec('SAVEPOINT feishu_task_resolve_deleted')
    try {
      if (operation) this.abandon(operation, 'decided_by_person', { keep, observed: 'deleted' })
      this.acceptDelete(todo.id, link.guid, undefined, { source: 'readback', deleted: true, guid: link.guid, code }, keep === 'feishu')
      if (keep === 'friday') {
        const owner = link.ownerOpenId ?? responsibleOpenId(todo) ?? ''
        const snapshot = this.snapshot(todo.id) ?? { identity: { ...anchorOf(todo), owner }, local: localOf(todo), remote: localOf(todo), statusAt: todo.statusAt, remoteAllDay: false }
        const deletion = { status: snapshot.deletion?.status ?? todo.status, statusAt: snapshot.deletion?.statusAt ?? todo.statusAt, source: 'readback' as const, recreate: true as const }
        this.deps.db.prepare('UPDATE feishu_task_links SET snapshot_json=? WHERE todo_id=?').run(JSON.stringify({ ...snapshot, deletion }), todo.id)
      }
      this.deps.db.exec('RELEASE feishu_task_resolve_deleted')
    } catch (error) { this.deps.db.exec('ROLLBACK TO feishu_task_resolve_deleted; RELEASE feishu_task_resolve_deleted'); throw error }
  }
}
