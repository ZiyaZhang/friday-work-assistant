import type { DatabaseSync } from 'node:sqlite'
import { ACTIVE_STATUSES, canTransition, dmPersonOf, responsibleOpenId, todoTag, type Todo, type TodoAudience, type TodoKind, type Todos, type TodoStatus } from './todos.js'
import type { TodoProvenance } from './todo-provenance.js'
import { nativeTaskRecorded } from './feishu-task-sync.js'

export { todoTag } from './todos.js'

export interface TodoPatch {
  title?: string
  detail?: string | null
  dueMs?: number | null
  status?: TodoStatus
  statusNote?: string | null
  confirm?: true
  /** Reassignment replaces both fields. A bare name never keeps the previous open_id. */
  owner?: string | null
  ownerOpenId?: string | null
}

export interface TodoCreateInput {
  title: string
  kind?: TodoKind
  detail?: string | null
  dueMs?: number | null
  owner?: string | null
  ownerOpenId?: string | null
  /** false marks a model-inferred candidate; it is not a human commitment until confirmed. */
  confirmed?: boolean
  source?: string | null
  sessionKey?: string | null
  provenance?: TodoProvenance
}

/** A console form carries the version it showed. A chat instruction names the change it wants
 * and is applied to the current version in the same transaction. */
export type TodoVersion = { expectedTag: string } | { current: true }

export type TodoRemoval = { outcome: 'deleted'; id: number } | { outcome: 'cancelled'; todo: Todo; tag: string }

export class TodoApplicationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message)
    this.name = 'TodoApplicationError'
  }
}

const KINDS: readonly TodoKind[] = ['todo', 'deadline', 'freeze', 'release', 'meeting']
const REMOVED_NOTE = '记错了，已删除'

/** The caller authorizes the current human/Space; these synchronous operations preserve that audience.
 * Chat, cards, console and meeting confirmations share them instead of writing Todos directly. */
export class TodoApplication {
  constructor(private readonly deps: { db: DatabaseSync; todos: Todos }) {}

  /** `actorOpenId` is null only for a host-owned background Run without a human requester. */
  create(audience: TodoAudience, input: TodoCreateInput, actorOpenId: string | null): { todo: Todo; tag: string } {
    if (actorOpenId !== null && (!actorOpenId || actorOpenId !== audience.openId)) throw new TodoApplicationError(403, 'actor_mismatch', '当前操作者不匹配')
    const value = validateCreate(input)
    const owner = resolveOwner(audience.scope, value.owner, value.ownerOpenId)
    const { db, todos } = this.deps
    db.exec('SAVEPOINT todo_application_create')
    try {
      const todo = todos.add({ scope: audience.scope, title: value.title, kind: value.kind,
        ...(value.detail !== null ? { detail: value.detail } : {}), ...(value.dueMs !== null ? { dueMs: value.dueMs } : {}),
        ...(owner.owner !== null ? { owner: owner.owner } : {}), ...(owner.ownerOpenId !== null ? { ownerOpenId: owner.ownerOpenId } : {}),
        confirmed: value.confirmed, ...(actorOpenId !== null ? { createdBy: actorOpenId } : {}),
        ...(value.sessionKey !== null ? { sessionKey: value.sessionKey } : {}), ...(value.source !== null ? { source: value.source } : {}),
        ...(value.provenance ? { provenance: value.provenance } : {}) })
      db.exec('RELEASE todo_application_create')
      return { todo, tag: todoTag(todo) }
    } catch (error) {
      db.exec('ROLLBACK TO todo_application_create; RELEASE todo_application_create')
      throw error
    }
  }

  update(id: number, audience: TodoAudience, input: TodoVersion & { patch: TodoPatch }, actorOpenId: string, options: { statusBy?: string } = {}): { todo: Todo; tag: string; changed: boolean } {
    this.assertActor(audience, actorOpenId)
    if (!Number.isSafeInteger(id) || id < 1) invalid('待办编号无效')
    validateVersion(input)
    const patch = validatePatch(input.patch)
    const { db, todos } = this.deps
    db.exec('SAVEPOINT todo_application')
    try {
      const current = this.current(id, audience, input)
      const expectedTag = todoTag(current)
      if (patch.confirm && !current.confirmed && actorOpenId !== responsibleOpenId(current) && actorOpenId !== current.createdBy) {
        throw new TodoApplicationError(403, 'candidate_confirmation_forbidden', '这条候选待办只有负责人本人或最初提出待办的人可以确认')
      }
      if (patch.status !== undefined && !canTransition(current.status, patch.status)) conflict('不支持这次状态转换')

      // Reopening is the only way to edit a terminal item. Keep the existing state machine authoritative.
      const reopening = !ACTIVE_STATUSES.includes(current.status) && patch.status === 'open'
      const transition = () => {
        if (!todos.transition(id, audience.scope, patch.status!, { by: options.statusBy ?? actorOpenId, note: patch.statusNote ?? undefined })) conflict('待办状态未能更新')
      }
      if (reopening) transition()
      const edit: { title?: string; detail?: string | null; dueMs?: number | null; owner?: string | null; ownerOpenId?: string | null } = {}
      if (patch.title !== undefined && patch.title !== current.title) edit.title = patch.title
      if (patch.detail !== undefined && patch.detail !== current.detail) edit.detail = patch.detail
      if (patch.dueMs !== undefined && patch.dueMs !== current.dueMs) edit.dueMs = patch.dueMs
      if ('owner' in patch || 'ownerOpenId' in patch) {
        const owner = resolveOwner(current.scope, patch.owner ?? null, patch.ownerOpenId ?? null)
        if (owner.owner !== current.owner) edit.owner = owner.owner
        if (owner.ownerOpenId !== current.ownerOpenId) edit.ownerOpenId = owner.ownerOpenId
      }
      if (Object.keys(edit).length && !todos.update(id, audience.scope, edit)) conflict('请先重开已结束的待办，再修改内容')
      if (patch.confirm && !current.confirmed && !todos.confirm(id, audience.scope)) conflict('请先重开已结束的待办，再确认')
      if (patch.status !== undefined && !reopening) transition()
      const todo = todos.getForAudience(id, audience)!
      const tag = todoTag(todo)
      db.exec('RELEASE todo_application')
      return { todo, tag, changed: tag !== expectedTag }
    } catch (error) {
      db.exec('ROLLBACK TO todo_application; RELEASE todo_application')
      throw error
    }
  }

  /**
   * “记错了，删掉”. A Todo that never produced an external native operation is deleted.
   * A link, an in-flight create or an unknown native write means a Feishu task may exist or
   * still appear, so the record stays as cancelled: native sync deletes the exact task and a
   * late create ACK still has a local owner to be cleaned up against.
   */
  remove(id: number, audience: TodoAudience, input: TodoVersion, actorOpenId: string): TodoRemoval {
    this.assertActor(audience, actorOpenId)
    if (!Number.isSafeInteger(id) || id < 1) invalid('待办编号无效')
    validateVersion(input)
    const { db, todos } = this.deps
    db.exec('SAVEPOINT todo_application_remove')
    try {
      const current = this.current(id, audience, input)
      let result: TodoRemoval
      if (!nativeTaskRecorded(db, id)) {
        if (!todos.remove(id, audience.scope)) conflict('待办未能删除')
        result = { outcome: 'deleted', id }
      } else {
        if (current.status === 'done' && !todos.transition(id, audience.scope, 'open', { by: actorOpenId })) conflict('待办状态未能更新')
        if (current.status !== 'cancelled' && !todos.transition(id, audience.scope, 'cancelled', { by: actorOpenId, note: REMOVED_NOTE })) conflict('待办状态未能更新')
        const todo = todos.getForAudience(id, audience)!
        result = { outcome: 'cancelled', todo, tag: todoTag(todo) }
      }
      db.exec('RELEASE todo_application_remove')
      return result
    } catch (error) {
      db.exec('ROLLBACK TO todo_application_remove; RELEASE todo_application_remove')
      throw error
    }
  }

  private assertActor(audience: TodoAudience, actorOpenId: string): void {
    if (!actorOpenId || actorOpenId !== audience.openId) throw new TodoApplicationError(403, 'actor_mismatch', '当前操作者不匹配')
  }

  private current(id: number, audience: TodoAudience, version: TodoVersion): Todo {
    const current = this.deps.todos.getForAudience(id, audience)
    if (!current) throw new TodoApplicationError(404, 'todo_not_found', '当前空间未找到这条待办')
    if ('expectedTag' in version && todoTag(current) !== version.expectedTag) throw new TodoApplicationError(409, 'todo_changed', '待办已更新，请刷新后再修改')
    return current
  }
}

/** D2: explicit open_id wins; only an unnamed owner in the person's own private chat defaults to them. */
function resolveOwner(scope: string, owner: string | null, ownerOpenId: string | null): { owner: string | null; ownerOpenId: string | null } {
  if (ownerOpenId !== null) return { owner, ownerOpenId }
  if (owner !== null) return { owner, ownerOpenId: null }
  return { owner: null, ownerOpenId: dmPersonOf(scope) }
}

function invalid(message: string): never { throw new TodoApplicationError(400, 'invalid_todo_patch', message) }
function conflict(message: string): never { throw new TodoApplicationError(409, 'invalid_todo_transition', message) }

function validateVersion(input: TodoVersion): void {
  if (!input || typeof input !== 'object') invalid('缺少有效的待办版本')
  if ('current' in input) { if (input.current !== true || 'expectedTag' in input) invalid('缺少有效的待办版本'); return }
  if (typeof input.expectedTag !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedTag)) invalid('缺少有效的待办版本')
}

function title(value: unknown): string {
  if (typeof value !== 'string') invalid('标题须为文本')
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 200) invalid('标题须为 1–200 字符')
  return normalized
}
function detail(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || value.length > 2000)) invalid('详情须为空或不超过 2000 字符')
  return value as string | null
}
function due(value: unknown): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || Math.abs(value as number) > 8.64e15)) invalid('截止时间无效')
  return value as number | null
}
function ownerName(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) invalid('负责人姓名须为空或 1–100 字符')
  return (value as string).trim()
}
function ownerId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('负责人标识无效')
  return value as string
}

function validateCreate(value: TodoCreateInput): Required<Omit<TodoCreateInput, 'provenance'>> & { provenance?: TodoProvenance } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请提供明确的待办内容')
  const keys = ['title', 'kind', 'detail', 'dueMs', 'owner', 'ownerOpenId', 'confirmed', 'source', 'sessionKey', 'provenance']
  if (Object.keys(value).some(key => !keys.includes(key))) invalid('待办内容包含不支持的字段')
  const kind = value.kind ?? 'todo'
  if (!KINDS.includes(kind)) invalid('待办类型无效')
  const dueMs = due(value.dueMs ?? null)
  if (kind !== 'todo' && dueMs === null) invalid(`${kind} 必须带时间`)
  if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean') invalid('确认状态无效')
  if (value.source !== undefined && value.source !== null && (typeof value.source !== 'string' || value.source.length > 200)) invalid('来源说明无效')
  if (value.sessionKey !== undefined && value.sessionKey !== null && (typeof value.sessionKey !== 'string' || !value.sessionKey)) invalid('会话标识无效')
  return { title: title(value.title), kind, detail: detail(value.detail ?? null), dueMs,
    owner: ownerName(value.owner ?? null), ownerOpenId: ownerId(value.ownerOpenId ?? null),
    confirmed: value.confirmed ?? true, source: value.source ?? null, sessionKey: value.sessionKey ?? null,
    ...(value.provenance !== undefined ? { provenance: value.provenance } : {}) }
}

function validatePatch(value: TodoPatch): TodoPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请提供明确的待办修改')
  const keys = Object.keys(value)
  if (!keys.length || keys.some(key => !['title', 'detail', 'dueMs', 'status', 'statusNote', 'confirm', 'owner', 'ownerOpenId'].includes(key))) invalid('待办修改包含不支持的字段')
  const patch: TodoPatch = {}
  if ('title' in value) patch.title = title(value.title)
  if ('detail' in value) patch.detail = detail(value.detail)
  if ('dueMs' in value) patch.dueMs = due(value.dueMs)
  if ('status' in value) {
    if (!['open', 'blocked', 'review', 'done', 'cancelled'].includes(value.status as string)) invalid('待办状态无效')
    patch.status = value.status
  }
  if ('statusNote' in value) {
    if (!('status' in value)) invalid('状态说明须与状态一起修改')
    if (value.statusNote !== null && (typeof value.statusNote !== 'string' || value.statusNote.trim().length > 300)) invalid('状态说明须为空或不超过 300 字符')
    patch.statusNote = value.statusNote?.trim() ?? null
  }
  if ('confirm' in value) {
    if (value.confirm !== true) invalid('仅支持明确确认待办')
    patch.confirm = true
  }
  if ('owner' in value) patch.owner = ownerName(value.owner)
  if ('ownerOpenId' in value) patch.ownerOpenId = ownerId(value.ownerOpenId)
  return patch
}
