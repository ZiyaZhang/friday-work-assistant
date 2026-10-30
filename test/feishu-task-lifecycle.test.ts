import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FeishuTaskSync, ensureFeishuTaskSyncSchema } from '../src/core/feishu-task-sync.js'
import { FeishuTasks, FeishuTaskError } from '../src/feishu/tasks.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication, todoTag, type TodoPatch } from '../src/core/todo-application.js'

const NOW = 1_800_000_000_000
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
type WireTask = { guid: string; summary: string; description?: string; due?: { timestamp: string; is_all_day: boolean }; completed_at: string; members: { id: string; role: string; type: string }[]; extra: string; updated_at: string }
function fixture(options: { cancellation?: 'delete' } = { cancellation: 'delete' }) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const todos = new Todos(db), application = new TodoApplication({ db, todos })
  let now = NOW, revision = 1, active = true, sequence = 0
  const remote = new Map<string, WireTask>()
  const calls: { method: string; guid?: string; data?: Record<string, any> }[] = []
  const api = {
    create: vi.fn(async (request: { data: Record<string, any> }) => {
      const guid = `task-${++sequence}`
      calls.push({ method: 'POST', data: structuredClone(request.data) })
      const task: WireTask = { guid, summary: request.data.summary, description: request.data.description,
        due: request.data.due, completed_at: request.data.completed_at ?? '0', members: request.data.members,
        extra: request.data.extra, updated_at: String(now) }
      remote.set(guid, task); return { code: 0, data: { task: structuredClone(task) } }
    }),
    get: vi.fn(async (request: { path: { task_guid: string } }) => {
      calls.push({ method: 'GET', guid: request.path.task_guid })
      const task = remote.get(request.path.task_guid)
      if (!task) throw new FeishuTaskError('读任务', 1470404, '任务不存在或已删除')
      return { code: 0, data: { task: structuredClone(task) } }
    }),
    patch: vi.fn(async (request: { path: { task_guid: string }; data: { task: Record<string, any>; update_fields: string[] } }) => {
      const task = remote.get(request.path.task_guid)!
      calls.push({ method: 'PATCH', guid: task.guid, data: structuredClone(request.data) })
      for (const field of request.data.update_fields) {
        if (field in request.data.task) (task as any)[field] = structuredClone(request.data.task[field])
        else delete (task as any)[field]
      }
      task.updated_at = String(now)
      return { code: 0, data: { task: structuredClone(task) } }
    }),
    delete: vi.fn(async (request: { path: { task_guid: string } }) => {
      calls.push({ method: 'DELETE', guid: request.path.task_guid }); remote.delete(request.path.task_guid)
      return { code: 0, data: {} }
    }),
    // Official add_members/remove_members ignore an existing/absent member and return the full task.
    addMembers: vi.fn(async (request: { path: { task_guid: string }; data: { members: { id: string; role: string; type?: string }[]; client_token?: string } }) => {
      const task = remote.get(request.path.task_guid)
      if (!task) throw new FeishuTaskError('转交任务', 1470404, '任务不存在或已删除')
      calls.push({ method: 'ADD_MEMBERS', guid: task.guid, data: structuredClone(request.data) })
      for (const member of request.data.members) {
        if (!task.members.some(item => item.id === member.id && item.role === member.role)) task.members.push({ id: member.id, role: member.role, type: member.type ?? 'user' })
      }
      task.updated_at = String(now); return { code: 0, data: { task: structuredClone(task) } }
    }),
    removeMembers: vi.fn(async (request: { path: { task_guid: string }; data: { members: { id: string; role: string; type?: string }[] } }) => {
      const task = remote.get(request.path.task_guid)
      if (!task) throw new FeishuTaskError('转交任务', 1470404, '任务不存在或已删除')
      calls.push({ method: 'REMOVE_MEMBERS', guid: task.guid, data: structuredClone(request.data) })
      task.members = task.members.filter(item => !request.data.members.some(member => member.id === item.id && member.role === item.role))
      task.updated_at = String(now); return { code: 0, data: { task: structuredClone(task) } }
    }),
  }
  const tasks = new FeishuTasks({ task: { v2: { task: api } } } as never)
  const deps = { db, todos, tasks, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    now: () => now, assertCurrent: () => { if (!active) throw new Error('host closed') }, permissionVersion: () => revision, ...options }
  let sync = new FeishuTaskSync(deps)
  const add = (title = '原事项') => todos.add({ scope: 'space:alice', sessionKey: 'alice-dm', title, detail: '原详情', dueMs: NOW + 86400_000, confirmed: true, createdBy: 'alice', ownerOpenId: 'alice' })
  const edit = (id: number, patch: TodoPatch) => application.update(id, { scope: 'space:alice', chatId: 'alice-dm', chatType: 'p2p', openId: 'alice' }, { expectedTag: todoTag(todos.get(id)!), patch }, 'alice')
  const sweep = async (limit?: number) => { now += 1_000; return sync.sweep(limit) }
  return { db, todos, application, api, calls, remote, tasks, add, edit, sweep, get sync() { return sync },
    restart: () => { sync = new FeishuTaskSync(deps) }, tick: (ms: number) => { now += ms }, changePermissions: () => { revision++ }, closeHost: () => { active = false } }
}

describe('native Task lifecycle through TodoApplication + real SDK adapter + durable SQLite receipts', () => {
  it('edits title/detail/deadline, clears fields, completes and reopens the same native task', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.edit(todo.id, { title: '新标题', detail: '新详情', dueMs: NOW + 999 })
    expect(await t.sweep()).toMatchObject({ updated: 1 })
    expect(t.remote.get('task-1')).toMatchObject({ summary: '新标题', description: '新详情', due: { timestamp: String(NOW + 999) } })
    t.edit(todo.id, { detail: null, dueMs: null }); await t.sweep()
    expect(t.remote.get('task-1')).not.toHaveProperty('description'); expect(t.remote.get('task-1')).not.toHaveProperty('due')
    t.edit(todo.id, { status: 'done' }); expect(await t.sweep()).toMatchObject({ completed: 1 })
    t.edit(todo.id, { status: 'open', title: '明确重开' }); expect(await t.sweep()).toMatchObject({ reopened: 1 })
    expect(t.remote.get('task-1')).toMatchObject({ summary: '明确重开', completed_at: '0' })
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.sync.link(todo.id)?.completedAt).toBeNull()
  })
  it('pulls native completion, reopen and human content edits without another patch', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    Object.assign(t.remote.get('task-1')!, { completed_at: String(NOW + 50), summary: '人在飞书改名', description: '', due: undefined })
    expect(await t.sweep()).toMatchObject({ pulledBack: 1 })
    expect(t.todos.get(todo.id)).toMatchObject({ status: 'done', doneAt: NOW + 50, title: '人在飞书改名', detail: null, dueMs: null })
    t.remote.get('task-1')!.completed_at = '0'; await t.sweep()
    expect(t.todos.get(todo.id)).toMatchObject({ status: 'open', doneAt: null, statusNote: '在飞书任务里重新打开' })
    expect(t.api.patch).not.toHaveBeenCalled()
  })
  it('merges independent human fields but never overwrites a same-field conflict', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.edit(todo.id, { title: '本地标题' }); t.remote.get('task-1')!.description = '飞书详情'
    expect(await t.sweep()).toMatchObject({ updated: 1, pulledBack: 1 })
    expect(t.todos.get(todo.id)?.detail).toBe('飞书详情')
    expect(t.api.patch.mock.calls[0]![0].data.update_fields).toEqual(['summary'])
    t.edit(todo.id, { title: '本地下一版' }); t.remote.get('task-1')!.summary = '远端下一版'
    expect(await t.sweep()).toMatchObject({ conflicts: 1, updated: 0 })
    expect(t.remote.get('task-1')!.summary).toBe('远端下一版')
    expect(t.todos.get(todo.id)?.title).toBe('本地下一版')
    expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'conflict', fields: ['summary'] })
  })
  it('keeps a newer local edit made while GET is pending; no stale push or pull', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '第一版' })
    const original = t.api.get.getMockImplementation()!
    t.api.get.mockImplementationOnce(async input => { const result = await original(input); t.edit(todo.id, { title: '第二版' }); return result })
    expect(await t.sweep()).toMatchObject({ skipped: 1 })
    expect(t.api.patch).not.toHaveBeenCalled(); expect(t.todos.get(todo.id)?.title).toBe('第二版')
    await t.sweep(); expect(t.remote.get('task-1')?.summary).toBe('第二版')
  })
  it('records a late PATCH ACK without erasing a newer local edit or unrelated remote human edit', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '第一版' })
    const original = t.api.patch.getMockImplementation()!
    t.api.patch.mockImplementationOnce(async input => {
      t.remote.get('task-1')!.description = '人在远端同时修改'
      const result = await original(input); t.edit(todo.id, { title: '第二版' }); return result
    })
    await t.sweep(); expect(t.todos.get(todo.id)?.title).toBe('第二版')
    await t.sweep()
    expect(t.todos.get(todo.id)?.detail).toBe('人在远端同时修改')
    expect(t.remote.get('task-1')?.summary).toBe('第二版')
    expect(t.api.patch).toHaveBeenCalledTimes(2)
  })
  it('cancel deletes the exact linked task; explicit reopen creates a new generation and preserves old ACK', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    expect(await t.sweep()).toMatchObject({ cancelled: 1 })
    expect(t.remote.has('task-1')).toBe(false)
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-1', generation: 0, deletedAt: expect.any(Number) })
    t.edit(todo.id, { status: 'open', title: '恢复后内容' }); expect(await t.sweep()).toMatchObject({ created: 1 })
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-2', generation: 1, deletedAt: null })
    expect(t.remote.get('task-2')).toMatchObject({ summary: '恢复后内容', completed_at: '0' })
    expect(t.db.prepare("SELECT result_json FROM feishu_task_operations WHERE kind='delete'").get()?.result_json).toContain('task-1')
    expect(t.api.create.mock.calls[0]![0].data.client_token).not.toBe(t.api.create.mock.calls[1]![0].data.client_token)
  })
  it('does not delete if the native task was edited since the last observation', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    t.remote.get('task-1')!.summary = '另一个人更新了原任务'
    expect(await t.sweep()).toMatchObject({ conflicts: 1, cancelled: 0 })
    expect(t.api.delete).not.toHaveBeenCalled(); expect(t.todos.get(todo.id)?.status).toBe('cancelled')
  })
  it('reconciles an unknown DELETE only by reading absence of its original GUID, then permits a new generation', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    const original = t.api.delete.getMockImplementation()!
    t.api.delete.mockImplementationOnce(async input => { await original(input); throw new Error('lost DELETE ACK') })
    expect(await t.sweep()).toMatchObject({ unknown: 1 }); expect(t.sync.link(todo.id)?.deletedAt).toBeNull()
    t.restart(); t.edit(todo.id, { status: 'open' })
    expect(await t.sweep()).toMatchObject({ cancelled: 1, created: 0 })
    expect(t.sync.status(todo.id).pending).toBeUndefined()
    expect(JSON.parse(String(t.db.prepare("SELECT result_json FROM feishu_task_operations WHERE kind='delete'").get()?.result_json)))
      .toEqual({ source: 'readback', deleted: true, guid: 'task-1', code: 1470404 })
    expect(await t.sweep()).toMatchObject({ created: 1 })
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-2', generation: 1 })
    expect(t.api.delete).toHaveBeenCalledTimes(1)
  })
  it('does not equate denial or network failure with DELETE success; retries the same DELETE only while cancellation is unchanged', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    t.api.delete.mockRejectedValueOnce(new Error('unknown DELETE outcome')); await t.sweep()
    t.api.get.mockRejectedValueOnce(new FeishuTaskError('读任务', 1470403, 'resource denied'))
    await t.sweep(); expect(t.sync.link(todo.id)?.deletedAt).toBeNull()
    t.api.get.mockRejectedValueOnce(new Error('socket unavailable')); await t.sweep()
    expect(t.sync.link(todo.id)?.deletedAt).toBeNull(); expect(t.api.delete).toHaveBeenCalledTimes(1)
    t.tick(60_000)
    expect(await t.sweep()).toMatchObject({ cancelled: 1, retried: 1 })
    expect(t.remote.has('task-1')).toBe(false); expect(t.api.delete).toHaveBeenCalledTimes(2)
    expect(t.db.prepare("SELECT count(*) AS n, max(attempts) AS attempts FROM feishu_task_operations WHERE kind='delete'").get()).toEqual({ n: 1, attempts: 2 })
  })
  it('keeps the old delete ACK if local reopen arrives while DELETE is in flight', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    const original = t.api.delete.getMockImplementation()!
    t.api.delete.mockImplementationOnce(async input => { t.edit(todo.id, { status: 'open', title: '重新安排' }); return original(input) })
    await t.sweep(); expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-1', deletedAt: expect.any(Number) })
    await t.sweep(); expect(t.remote.get('task-2')?.summary).toBe('重新安排')
    expect(t.api.delete).toHaveBeenCalledTimes(1)
  })
  it('a native deletion cancels unchanged active local state; only an explicit reopen creates again', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.remote.delete('task-1')
    await t.sweep(); await t.sweep()
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.todos.get(todo.id)).toMatchObject({ status: 'cancelled', statusNote: '在飞书任务里删除' })
    t.edit(todo.id, { status: 'open' }); await t.sweep()
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-2', generation: 1 })
  })
  it('native deletion of a completed task does not force an invalid local transition or silently recreate it', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'done' }); await t.sweep()
    t.remote.delete('task-1'); await t.sweep(); await t.sweep()
    expect(t.todos.get(todo.id)?.status).toBe('done'); expect(t.api.create).toHaveBeenCalledTimes(1)
    t.edit(todo.id, { status: 'open' }); await t.sweep()
    expect(t.sync.link(todo.id)?.generation).toBe(1)
  })
  it('native deletion does not cancel a concurrent explicit local edit', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '新委托' }); t.remote.delete('task-1')
    await t.sweep(); expect(t.todos.get(todo.id)).toMatchObject({ status: 'open', title: '新委托' })
    expect(t.sync.link(todo.id)?.issue?.reason).toBe('remote_missing'); expect(t.api.create).toHaveBeenCalledTimes(1)
  })
  it('has no destructive cancellation default for an unconfigured host', async () => {
    const t = fixture({}), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' }); await t.sweep()
    expect(t.api.delete).not.toHaveBeenCalled(); expect(t.api.patch).not.toHaveBeenCalled()
    expect(t.sync.link(todo.id)?.issue?.reason).toBe('cancellation_policy_required')
  })
  it('never repeats an unknown create even after restart and payload edits; exact own marker can reconcile', async () => {
    const t = fixture(), todo = t.add(), original = t.api.create.getMockImplementation()!
    t.api.create.mockImplementationOnce(async input => { await original(input); throw new Error('socket lost after POST') })
    expect(await t.sweep()).toMatchObject({ unknown: 1, created: 0 })
    t.restart(); t.edit(todo.id, { title: '后续新标题' }); await t.sweep()
    expect(t.api.create).toHaveBeenCalledTimes(1); expect(t.sync.status(todo.id).pending?.kind).toBe('create')
    const marker = t.remote.get('task-1')!.extra; t.remote.get('task-1')!.extra = 'foreign'
    expect(await t.sync.reconcileCreation(todo.id, 'task-1')).toBe(false)
    t.remote.get('task-1')!.extra = marker
    expect(await t.sync.reconcileCreation(todo.id, 'task-1')).toBe(true)
    await t.sweep(); expect(t.remote.get('task-1')?.summary).toBe('后续新标题')
    expect(t.api.create).toHaveBeenCalledTimes(1)
  })
  it('an unknown create does not consume every later creation slot', async () => {
    const t = fixture(); t.add(); t.api.create.mockRejectedValueOnce(new Error('unknown'))
    await t.sweep(1); const newer = t.add('后续事项'); expect(await t.sweep(1)).toMatchObject({ created: 1 })
    expect(t.sync.link(newer.id)).toBeDefined()
  })
  it('reconciles a lost PATCH ACK by exact GET; does not repeat the patch', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '明确更新' })
    const original = t.api.patch.getMockImplementation()!
    t.api.patch.mockImplementationOnce(async input => { await original(input); throw new Error('lost patch ACK') })
    expect(await t.sweep()).toMatchObject({ unknown: 1 }); t.restart(); await t.sweep()
    expect(t.sync.status(todo.id).pending).toBeUndefined(); expect(t.api.patch).toHaveBeenCalledTimes(1)
  })
  it('retries an unknown PATCH only after the retry delay, while the remote is at the baseline and the target is unchanged', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '明确更新' })
    t.api.patch.mockRejectedValueOnce(new Error('unknown whether sent'))
    await t.sweep(); t.restart(); expect(await t.sweep()).toMatchObject({ unknown: 1, retried: 0 })
    expect(t.api.patch).toHaveBeenCalledTimes(1)
    t.tick(60_000); expect(await t.sweep()).toMatchObject({ retried: 1, updated: 1 })
    expect(t.remote.get('task-1')?.summary).toBe('明确更新'); expect(t.api.patch).toHaveBeenCalledTimes(2)
    t.api.get.mockRejectedValueOnce(new FeishuTaskError('读任务', 1470403, 'resource denied'))
    await t.sweep(); expect(t.sync.link(todo.id)?.deletedAt).toBeNull()
  })
  it.each(['revision', 'cooldown'] as const)('recovers an explicit scope rejection after %s without treating network unknown as rejected', async kind => {
    const t = fixture(); t.add()
    t.api.create.mockResolvedValueOnce({ code: 99991672, data: {} } as never)
    expect(await t.sweep()).toMatchObject({ blocked: true, created: 0 })
    await t.sweep(); expect(t.api.create).toHaveBeenCalledTimes(1)
    if (kind === 'revision') t.changePermissions(); else t.tick(5 * 60_000)
    expect(await t.sweep()).toMatchObject({ created: 1 }); expect(t.api.create).toHaveBeenCalledTimes(2)
  })
  it('overlapping sweeps share one in-flight creation and preserve ACK after host closing', async () => {
    const t = fixture(), todo = t.add(), original = t.api.create.getMockImplementation()!
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
    t.api.create.mockImplementationOnce(async input => { await held; return original(input) })
    const a = t.sweep(), b = t.sync.sweep()
    release(); t.closeHost()
    await expect(a).rejects.toThrow('host closed'); await expect(b).rejects.toThrow('host closed')
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.sync.link(todo.id)?.guid).toBe('task-1')
    expect(t.db.prepare('SELECT state FROM feishu_task_operations').get()?.state).toBe('returned')
  })
  it.each(['scope', 'unconfirm'] as const)('does not continue an existing mirror after %s changes', async kind => {
    const t = fixture(), todo = t.add(); await t.sweep()
    if (kind === 'scope') t.db.prepare('UPDATE todos SET scope=? WHERE id=?').run('space:bob', todo.id)
    if (kind === 'unconfirm') t.db.prepare('UPDATE todos SET confirmed=0 WHERE id=?').run(todo.id)
    await t.sweep(); expect(t.api.get).not.toHaveBeenCalled(); expect(t.api.patch).not.toHaveBeenCalled()
    expect(t.sync.link(todo.id)?.issue?.reason).toBe('identity_changed')
  })
  it('keeps legacy rows unchanged at schema upgrade, then refuses to invent a disagreement baseline', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.db.prepare('UPDATE feishu_task_links SET snapshot_json=NULL WHERE todo_id=?').run(todo.id)
    const old = t.db.prepare('SELECT * FROM feishu_task_links').all()
    ensureFeishuTaskSyncSchema(t.db); ensureFeishuTaskSyncSchema(t.db)
    expect(t.db.prepare('SELECT * FROM feishu_task_links').all()).toEqual(old)
    t.remote.get('task-1')!.summary = '过去人改过的标题'
    expect(await t.sweep()).toMatchObject({ conflicts: 1 }); expect(t.api.patch).not.toHaveBeenCalled()
    expect(t.sync.link(todo.id)?.issue?.reason).toBe('legacy_conflict')
  })
  it('adds nullable proof columns without inventing historical sync receipts or changing old links', () => {
    const db = new DatabaseSync(':memory:'); databases.push(db)
    db.exec(`CREATE TABLE feishu_task_links(todo_id INTEGER PRIMARY KEY,guid TEXT NOT NULL,url TEXT,owner_open_id TEXT,created_at INTEGER NOT NULL,synced_at INTEGER NOT NULL,completed_at INTEGER);
      INSERT INTO feishu_task_links VALUES(41,'old-guid','https://old/task','alice',11,12,13)`)
    ensureFeishuTaskSyncSchema(db); ensureFeishuTaskSyncSchema(db)
    expect(db.prepare('SELECT * FROM feishu_task_links').get()).toEqual({ todo_id: 41, guid: 'old-guid', url: 'https://old/task', owner_open_id: 'alice', created_at: 11, synced_at: 12, completed_at: 13,
      snapshot_json: null, generation: 0, deleted_at: null, issue_json: null, last_verified_at: null })
    expect(db.prepare('SELECT count(*) AS n FROM feishu_task_operations').get()?.n).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM feishu_task_permission_blocks').get()?.n).toBe(0)
  })
  it('retains a scope rejection across restart, exposes safe recovery details and creates once after recovery', async () => {
    const t = fixture(), todo = t.add()
    t.api.create.mockResolvedValueOnce({ code: 99991672, msg: 'Requires task:task:write or task:task:writeonly. PRIVATE_PROVIDER_DETAIL' } as never)
    expect(await t.sweep()).toMatchObject({ created: 0, blockedCapabilities: ['write'] })
    const failed = t.sync.availability([todo])
    expect(failed).toMatchObject({ source: 'feishu_tasks', coverage: 'friday_mirror_only', state: 'permission_required', lastSuccessAt: null,
      requiredScopes: ['task:task:write', 'task:task:writeonly'], nextStep: expect.stringContaining('个人重新连接无法补齐') })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_PROVIDER_DETAIL')
    expect(JSON.stringify(t.db.prepare('SELECT * FROM feishu_task_permission_blocks').all())).not.toContain('PRIVATE_PROVIDER_DETAIL')
    t.restart(); await t.sweep()
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.sync.view(todo)).toMatchObject({ state: 'permission_required', lastSuccessAt: null, retryAt: expect.any(Number) })
    // Local completion remains authoritative while native permissions are unavailable.
    t.edit(todo.id, { status: 'done' }); t.tick(5 * 60_000)
    expect(await t.sweep()).toMatchObject({ created: 1 })
    expect(t.remote.get('task-1')?.completed_at).not.toBe('0')
    expect(t.sync.availability([t.todos.get(todo.id)!])).toMatchObject({ state: 'available', blockedCapabilities: [], requiredScopes: [], lastSuccessAt: expect.any(Number) })
    expect(t.db.prepare('SELECT count(*) AS n FROM feishu_task_permission_blocks').get()?.n).toBe(0)
    await t.sweep(); expect(t.api.create).toHaveBeenCalledTimes(2)
    expect(t.todos.get(todo.id)?.status).toBe('done')
  })
  it('never reports failed polls or another person’s observations as this list’s last success', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    const verified = t.sync.view(todo).lastSuccessAt
    expect(verified).toEqual(expect.any(Number))
    t.api.get.mockRejectedValueOnce(new Error('provider disconnected'))
    t.tick(60_000); await t.sweep()
    expect(t.sync.view(todo)).toMatchObject({ state: 'unavailable', lastSuccessAt: verified })
    expect(Number(t.db.prepare('SELECT synced_at FROM feishu_task_links').get()?.synced_at)).toBeGreaterThan(verified!)
    expect(t.sync.availability([])).toMatchObject({ state: 'not_checked', lastSuccessAt: null })
    expect(t.sync.availability([todo])).toMatchObject({ lastSuccessAt: verified })
  })
})

describe('user decisions 2026-09-22: permissions, owner, transfer and unknown results', () => {
  const alice = { scope: 'space:alice', chatId: 'alice-dm', chatType: 'p2p' as const, openId: 'alice' }

  it('a missing delete scope blocks only deletion: other tasks are still read, edited and created', async () => {
    const t = fixture(), keep = t.add('保留事项'), gone = t.add('取消事项'); await t.sweep()
    t.api.delete.mockResolvedValue({ code: 99991672, msg: 'scope required' } as never)
    t.edit(gone.id, { status: 'cancelled' }); t.edit(keep.id, { title: '保留事项改名' })
    const fresh = t.add('新事项')
    let result
    for (let i = 0; i < 3; i++) { t.tick(6 * 60_000); result = await t.sweep() }
    expect(t.remote.get(t.sync.link(keep.id)!.guid)?.summary).toBe('保留事项改名')
    expect(t.sync.link(fresh.id)).toBeDefined()
    expect(t.sync.link(gone.id)).toMatchObject({ deletedAt: null, issue: { reason: 'permission_required', fields: ['delete'] } })
    expect(t.sync.view(t.todos.get(gone.id)!)).toMatchObject({ state: 'permission_required' })
    expect(result).toMatchObject({ blocked: true, blockedCapabilities: ['delete'] })
    expect(t.api.delete.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('never guesses an owner: named-without-open_id and ownerless group items stay local and do not starve creation', async () => {
    const t = fixture(), legit = t.add('本人事项')
    for (let i = 0; i < 35; i++) t.todos.add({ scope: 'space:group-1', sessionKey: 'group-1', title: `群里无主事项${i}`, confirmed: true, createdBy: 'alice' })
    const named = t.todos.add({ scope: 'space:sp_dm_alice', title: '帮小王记', owner: '小王', confirmed: true, createdBy: 'alice' })
    const mine = t.todos.add({ scope: 'space:sp_dm_alice', title: '私聊里没说谁', confirmed: true, createdBy: 'alice' })
    expect(await t.sweep()).toMatchObject({ created: 2 })
    expect(t.sync.link(legit.id)).toBeDefined()
    expect(t.remote.get(t.sync.link(mine.id)!.guid)?.members).toEqual([{ id: 'alice', type: 'user', role: 'assignee' }])
    expect(t.sync.link(named.id)).toBeUndefined()
    expect(t.sync.view(named)).toMatchObject({ state: 'owner_unknown' })
  })

  it('a removal while creation is in flight keeps the record, accepts the late ACK and then deletes the task', async () => {
    const t = fixture(), todo = t.add('正在创建时取消'), original = t.api.create.getMockImplementation()!
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
    t.api.create.mockImplementationOnce(async input => { await held; return original(input) })
    const running = t.sweep()
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.application.remove(todo.id, alice, { current: true }, 'alice')).toMatchObject({ outcome: 'cancelled' })
    release(); await running
    expect(t.sync.link(todo.id)?.guid).toBe('task-1')
    expect(await t.sweep()).toMatchObject({ cancelled: 1 })
    expect(t.remote.has('task-1')).toBe(false); expect(t.todos.get(todo.id)?.status).toBe('cancelled')
  })

  it('reassigns the same native task by adding the new assignee, then removing the previous one', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.edit(todo.id, { owner: 'Bob', ownerOpenId: 'bob' })
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'transferring' })
    expect(await t.sweep()).toMatchObject({ transferred: 1 })
    expect(t.remote.get('task-1')?.members).toEqual([{ id: 'bob', role: 'assignee', type: 'user' }])
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-1', ownerOpenId: 'bob', generation: 0 })
    expect(t.api.create).toHaveBeenCalledTimes(1); expect(t.api.delete).not.toHaveBeenCalled()
    expect(t.calls.filter(call => call.method.endsWith('MEMBERS')).map(call => call.method)).toEqual(['ADD_MEMBERS', 'REMOVE_MEMBERS'])
    t.edit(todo.id, { title: '转交后改名' }); await t.sweep(); expect(t.remote.get('task-1')?.summary).toBe('转交后改名')
  })

  it('shows a half-finished transfer as transferring and completes it without adding twice', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { owner: 'Bob', ownerOpenId: 'bob' })
    t.api.removeMembers.mockRejectedValueOnce(new Error('timeout after add'))
    expect(await t.sweep()).toMatchObject({ transferred: 0, unknown: 1 })
    expect(t.remote.get('task-1')?.members.map(member => member.id).sort()).toEqual(['alice', 'bob'])
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'transferring' })
    expect(t.sync.link(todo.id)?.ownerOpenId).toBe('alice')
    t.restart(); t.tick(60_000)
    expect(await t.sweep()).toMatchObject({ transferred: 1, retried: 1 })
    expect(t.remote.get('task-1')?.members).toEqual([{ id: 'bob', role: 'assignee', type: 'user' }])
    expect(t.api.addMembers).toHaveBeenCalledTimes(1); expect(t.api.removeMembers).toHaveBeenCalledTimes(2)
  })

  it('a reassignment made directly in Feishu is a conflict, not an owner Friday guesses', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.remote.get('task-1')!.members = [{ id: 'carol', role: 'assignee', type: 'user' }]
    expect(await t.sweep()).toMatchObject({ conflicts: 1 })
    expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'conflict', fields: ['owner'] })
    expect(t.todos.get(todo.id)?.ownerOpenId).toBe('alice'); expect(t.api.addMembers).not.toHaveBeenCalled()
  })

  it('a cancelled Todo still deletes its native task even after its owner became a bare name', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.edit(todo.id, { owner: '小王' }); t.edit(todo.id, { status: 'cancelled' })
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'syncing', label: expect.stringContaining('已取消') })
    expect(await t.sweep()).toMatchObject({ cancelled: 1 })
    expect(t.remote.has('task-1')).toBe(false); expect(t.api.addMembers).not.toHaveBeenCalled()
  })

  it('an owner changed to a bare name stops native writes until someone with an open_id is named', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { owner: '小王' })
    await t.sweep(); expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'owner_unknown' })
    expect(t.api.addMembers).not.toHaveBeenCalled(); expect(t.api.patch).not.toHaveBeenCalled()
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'owner_unknown' })
  })

  it('after an unknown PATCH a newer local edit waits for evidence; the late result is then confirmed and the newest edit wins', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '第一版' })
    t.api.patch.mockRejectedValueOnce(new Error('timeout'))
    await t.sweep(); t.edit(todo.id, { title: '第二版' }); t.tick(60_000)
    expect(await t.sweep()).toMatchObject({ unknown: 1, updated: 0 })
    expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'unknown_write', fields: ['summary'] })
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'unverified' })
    expect(t.api.patch).toHaveBeenCalledTimes(1)
    t.remote.get('task-1')!.summary = '第一版'
    expect(await t.sweep()).toMatchObject({ updated: 1 })
    expect(t.remote.get('task-1')?.summary).toBe('第二版'); expect(t.todos.get(todo.id)?.title).toBe('第二版')
    expect(JSON.parse(String(t.db.prepare("SELECT result_json FROM feishu_task_operations WHERE kind='patch' ORDER BY created_at, rowid LIMIT 1").get()?.result_json)))
      .toMatchObject({ source: 'readback' })
  })

  it('retries an unknown write at most three times in total, then waits for a human decision', async () => {
    const t = fixture(), todo = t.add(), original = t.api.patch.getMockImplementation()!; await t.sweep(); t.edit(todo.id, { title: '一直超时' })
    t.api.patch.mockRejectedValue(new Error('timeout'))
    for (let i = 0; i < 5; i++) { t.tick(60_000); await t.sweep() }
    expect(t.api.patch).toHaveBeenCalledTimes(3)
    expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'unknown_write', fields: ['summary'] })
    expect(t.db.prepare("SELECT attempts, state FROM feishu_task_operations WHERE kind='patch'").get()).toEqual({ attempts: 3, state: 'started' })
    t.api.patch.mockImplementation(original)
    expect(await t.sync.resolveConflict(todo.id, 'friday')).toBe(true)
    await t.sweep(); expect(t.remote.get('task-1')?.summary).toBe('一直超时')
    expect(t.db.prepare("SELECT state FROM feishu_task_operations WHERE kind='patch' ORDER BY created_at, rowid LIMIT 1").get()?.state).toBe('abandoned')
  })

  it('a human decision resolves a same-field conflict in either direction', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.edit(todo.id, { title: '本地版' }); t.remote.get('task-1')!.summary = '飞书版'
    await t.sweep(); expect(t.sync.link(todo.id)?.issue?.reason).toBe('conflict')
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'needs_decision', fields: ['summary'] })
    expect(await t.sync.resolveConflict(todo.id, 'feishu')).toBe(true)
    await t.sweep(); expect(t.todos.get(todo.id)?.title).toBe('飞书版')
    t.edit(todo.id, { title: '本地再改' }); t.remote.get('task-1')!.summary = '飞书再改'; await t.sweep()
    expect(await t.sync.resolveConflict(todo.id, 'friday')).toBe(true)
    await t.sweep(); expect(t.remote.get('task-1')?.summary).toBe('本地再改')
  })

  it('describes the native state without claiming a local save reached Feishu', async () => {
    const t = fixture(), todo = t.add()
    expect(t.sync.view(todo)).toMatchObject({ state: 'queued' })
    expect(t.sync.view(t.todos.add({ scope: 'space:alice', title: '候选', confirmed: false, ownerOpenId: 'alice' }))).toMatchObject({ state: 'not_applicable' })
    await t.sweep(); expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'synced' })
    t.edit(todo.id, { title: '本地已存' }); expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'local_pending' })
    t.edit(todo.id, { status: 'cancelled' }); await t.sweep()
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'deleted' })
  })
})

describe('review fixes 2026-09-23: no permanent stuck states and no stale decisions', () => {
  const unresolvedPatchThenDeletedInFeishu = async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '新标题' })
    t.api.patch.mockRejectedValueOnce(new Error('timeout')); await t.sweep()
    t.remote.delete('task-1'); t.tick(60_000)
    expect(await t.sweep()).toMatchObject({ cancelled: 0 })
    expect(t.sync.status(todo.id).pending).toBeUndefined()
    expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'remote_missing' })
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'needs_decision' })
    return { t, todo }
  }

  it('a task deleted in Feishu while a PATCH is unresolved closes the PATCH; keeping Friday recreates it', async () => {
    const { t, todo } = await unresolvedPatchThenDeletedInFeishu()
    expect(await t.sync.resolveConflict(todo.id, 'friday')).toBe(true)
    expect(await t.sweep()).toMatchObject({ created: 1 })
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-2', generation: 1, deletedAt: null })
    expect(t.remote.get('task-2')?.summary).toBe('新标题')
  })

  it('keeping Feishu after the task was deleted there cancels the Friday item and never recreates it', async () => {
    const { t, todo } = await unresolvedPatchThenDeletedInFeishu()
    expect(await t.sync.resolveConflict(todo.id, 'feishu')).toBe(true)
    expect(t.todos.get(todo.id)?.status).toBe('cancelled')
    await t.sweep(); expect(t.api.create).toHaveBeenCalledTimes(1)
  })

  it('a PATCH answered with 1470404 is closed as deleted instead of staying unknown', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { title: '新标题' })
    t.api.patch.mockImplementationOnce(async () => { t.remote.delete('task-1'); throw new FeishuTaskError('改任务', 1470404, '任务不存在或已删除') })
    expect(await t.sweep()).toMatchObject({ unknown: 0 })
    expect(t.sync.status(todo.id).pending).toBeUndefined()
    await t.sweep(); expect(t.sync.link(todo.id)?.issue).toEqual({ reason: 'remote_missing' })
  })

  it('a half-finished transfer re-plans when the owner changes again and ends with exactly one assignee', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { owner: 'Bob', ownerOpenId: 'bob' })
    t.api.removeMembers.mockRejectedValueOnce(new Error('timeout')); await t.sweep()
    t.edit(todo.id, { owner: 'Carol', ownerOpenId: 'carol' }); t.tick(60_000)
    await t.sweep(); await t.sweep()
    expect(t.remote.get('task-1')?.members).toEqual([{ id: 'carol', role: 'assignee', type: 'user' }])
    expect(t.sync.link(todo.id)).toMatchObject({ guid: 'task-1', ownerOpenId: 'carol' })
    expect(t.sync.link(todo.id)?.issue).toBeUndefined()
  })

  it('cancelling during a half-finished transfer still deletes the native task', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { owner: 'Bob', ownerOpenId: 'bob' })
    t.api.removeMembers.mockRejectedValueOnce(new Error('timeout')); await t.sweep()
    t.edit(todo.id, { status: 'cancelled' }); t.tick(60_000)
    expect(await t.sweep()).toMatchObject({ cancelled: 1 })
    expect(t.remote.has('task-1')).toBe(false)
  })

  it('an exhausted transfer step asks for a decision instead of showing “转交中” forever', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { owner: 'Bob', ownerOpenId: 'bob' })
    t.api.removeMembers.mockRejectedValue(new Error('timeout'))
    for (let i = 0; i < 4; i++) { t.tick(60_000); await t.sweep() }
    expect(t.api.removeMembers).toHaveBeenCalledTimes(3)
    expect(t.sync.view(t.todos.get(todo.id)!)).toMatchObject({ state: 'unverified' })
  })

  it('a person can abandon an unknown re-creation after restore, and the stuck item does not starve the linked queue', async () => {
    const t = fixture(), stuck = t.add('将卡住'), other = t.add('照常'); await t.sweep()
    t.edit(stuck.id, { status: 'cancelled' }); await t.sweep()
    t.edit(stuck.id, { status: 'open' }); t.api.create.mockRejectedValueOnce(new Error('timeout')); await t.sweep()
    t.edit(other.id, { title: '照常改名' })
    await t.sweep(1); await t.sweep(1)
    expect(t.remote.get(t.sync.link(other.id)!.guid)?.summary).toBe('照常改名')
    expect(t.sync.view(t.todos.get(stuck.id)!)).toMatchObject({ state: 'unverified' })
    expect(t.sync.abandonCreation(stuck.id)).toBe(true)
    expect(await t.sweep()).toMatchObject({ created: 1 })
    expect(t.sync.link(stuck.id)).toMatchObject({ generation: 1, deletedAt: null })
  })

  it('closes deterministic Task v2 rejections and rate limits as rejected instead of unknown', async () => {
    const t = fixture(); t.add()
    t.api.create.mockResolvedValueOnce({ code: 1470400, msg: 'invalid param' } as never)
    expect(await t.sweep()).toMatchObject({ created: 0, unknown: 0 })
    expect(t.db.prepare('SELECT state, error_code FROM feishu_task_operations').get()).toEqual({ state: 'rejected', error_code: 1470400 })
    t.api.create.mockResolvedValueOnce({ code: 99991400, msg: 'request trigger frequency limit' } as never)
    expect(await t.sweep()).toMatchObject({ created: 0, unknown: 0, blocked: true })
    await t.sweep(); expect(t.api.create).toHaveBeenCalledTimes(2)
    t.tick(61_000); expect(await t.sweep()).toMatchObject({ created: 1 })
  })

  it('choosing Friday for oversized Feishu content writes Friday’s content', async () => {
    const t = fixture(), todo = t.add(); await t.sweep()
    t.remote.get('task-1')!.summary = '长'.repeat(201)
    expect(await t.sweep()).toMatchObject({ conflicts: 1 }); expect(t.sync.link(todo.id)?.issue?.reason).toBe('invalid_remote')
    expect(await t.sync.resolveConflict(todo.id, 'friday')).toBe(true)
    expect(await t.sweep()).toMatchObject({ updated: 1 })
    expect(t.remote.get('task-1')?.summary).toBe('原事项')
  })

  it('choosing Feishu for a cancel conflict keeps the Feishu task and reopens the Friday item', async () => {
    const t = fixture(), todo = t.add(); await t.sweep(); t.edit(todo.id, { status: 'cancelled' })
    t.remote.get('task-1')!.summary = '飞书里改过'
    expect(await t.sweep()).toMatchObject({ conflicts: 1 })
    expect(await t.sync.resolveConflict(todo.id, 'feishu')).toBe(true)
    expect(t.todos.get(todo.id)?.status).toBe('open')
    expect(await t.sweep()).toMatchObject({ pulledBack: 1, conflicts: 0 })
    expect(t.todos.get(todo.id)?.title).toBe('飞书里改过'); expect(t.remote.has('task-1')).toBe(true)
  })
})
