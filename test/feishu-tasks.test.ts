import { describe, expect, it, vi } from 'vitest'
import { FeishuTasks, FeishuTaskError } from '../src/feishu/tasks.js'

// Task v2 documents due.timestamp and completed_at as milliseconds:
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/task-v2/task/create
const DUE = 1_790_179_200_123
function fixture() {
  const task = { guid: 'synthetic-task', summary: '合成任务', completed_at: '0' }
  const api = {
    create: vi.fn(async () => ({ code: 0, data: { task } })),
    patch: vi.fn(async (input: { data: { task: { completed_at?: string } } }) => {
      Object.assign(task, input.data.task)
      return { code: 0, data: { task } }
    }),
    get: vi.fn(async () => ({ code: 0, data: { task } })),
    delete: vi.fn(async () => ({ code: 0, data: {} })),
    addMembers: vi.fn(async () => ({ code: 0, data: { task: { ...task, members: [{ id: 'ou_old', type: 'user', role: 'assignee' }, { id: 'ou_new', type: 'user', role: 'assignee' }] } } })),
    removeMembers: vi.fn(async () => ({ code: 0, data: { task: { ...task, members: [{ id: 'ou_new', type: 'user', role: 'assignee' }] } } })),
  }
  return { tasks: new FeishuTasks({ task: { v2: { task: api } } } as never), api, task }
}

describe('Feishu Task v2 wire timestamps', () => {
  it('sends a completed local task as completed at creation in milliseconds', async () => {
    const t = fixture()
    await t.tasks.create({ summary: '已完成事项', clientToken: 'synthetic-done', completedAtMs: DUE })
    expect(t.api.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completed_at: String(DUE) }) }))
  })

  it('preserves the millisecond deadline on create and edit, and clears only when requested', async () => {
    const t = fixture()
    await t.tasks.create({ summary: '合成任务', dueMs: DUE, clientToken: 'synthetic-idempotency', assigneeOpenIds: ['ou_synthetic'] })
    expect(t.api.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      due: { timestamp: String(DUE), is_all_day: false },
      members: [{ id: 'ou_synthetic', type: 'user', role: 'assignee' }], client_token: 'synthetic-idempotency',
    }) }))
    await t.tasks.patch('synthetic-task', { dueMs: DUE + 86_400_000 })
    expect(t.api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ data: {
      task: { due: { timestamp: String(DUE + 86_400_000), is_all_day: false } }, update_fields: ['due'],
    } }))
    await t.tasks.patch('synthetic-task', { dueMs: null })
    expect(t.api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ data: { task: {}, update_fields: ['due'] } }))
  })

  it('round-trips completion in milliseconds and retains the zero reopen sentinel', async () => {
    const t = fixture()
    expect((await t.tasks.setCompleted('synthetic-task', true, DUE)).completedAt).toBe(DUE)
    expect(t.api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ data: {
      task: { completed_at: String(DUE) }, update_fields: ['completed_at'],
    } }))
    expect((await t.tasks.get('synthetic-task')).completedAt).toBe(DUE)
    expect((await t.tasks.setCompleted('synthetic-task', false)).completedAt).toBeUndefined()
    expect(t.task.completed_at).toBe('0')
  })

  it('rejects malformed dates before any remote write', async () => {
    const t = fixture()
    await expect(t.tasks.create({ summary: '无效时间', dueMs: Infinity, clientToken: 'synthetic' })).rejects.toThrow('毫秒时间戳')
    await expect(t.tasks.setCompleted('synthetic-task', true, NaN)).rejects.toThrow('毫秒时间戳')
    expect(t.api.create).not.toHaveBeenCalled(); expect(t.api.patch).not.toHaveBeenCalled()
  })

  it('classifies HTTP-level scope rejection so synchronization stops retrying', async () => {
    const t = fixture()
    const rejected = { response: { data: { code: 99991672, msg: 'Required task:task:write scope' } }, config: { private: 'MUST_NOT_RETAIN' } }
    t.api.create.mockRejectedValueOnce(rejected)
    const error = await t.tasks.create({ summary: '合成任务', clientToken: 'synthetic' }).catch(value => value)
    expect(error).toBeInstanceOf(FeishuTaskError)
    expect(error.isPermission).toBe(true)
    expect(JSON.stringify(error)).not.toContain('MUST_NOT_RETAIN')
  })
  it('preserves human details, deadline mode, owner, update evidence and host marker on GET', async () => {
    const t = fixture()
    Object.assign(t.task, { description: '明确详情', due: { timestamp: String(DUE), is_all_day: true }, updated_at: String(DUE + 1), extra: 'host-operation',
      members: [{ id: 'alice', type: 'user', role: 'assignee' }, { id: 'bob', type: 'user', role: 'follower' }] })
    expect(await t.tasks.get('synthetic-task')).toMatchObject({ description: '明确详情', dueMs: DUE, dueIsAllDay: true, updatedAt: DUE + 1, extra: 'host-operation', assigneeOpenIds: ['alice'] })
  })
  it('patches description explicitly and sends exact GUID deletion only after a successful provider ACK', async () => {
    const t = fixture()
    await t.tasks.patch('synthetic-task', { description: '新详情', completedAtMs: 0 })
    expect(t.api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ data: { task: { description: '新详情', completed_at: '0' }, update_fields: ['description', 'completed_at'] } }))
    await t.tasks.patch('synthetic-task', { description: null })
    expect(t.api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ data: { task: {}, update_fields: ['description'] } }))
    await t.tasks.delete('synthetic-task')
    expect(t.api.delete).toHaveBeenCalledWith({ path: { task_guid: 'synthetic-task' } })
    t.api.delete.mockResolvedValueOnce({ code: 1470403, data: {} })
    await expect(t.tasks.delete('synthetic-task')).rejects.toMatchObject({ code: 1470403, isResourceDenied: true, isNotFound: false })
  })
  it('does not infer a known rejection from unstructured permission words', () => {
    const error = new FeishuTaskError('建任务', 1470500, 'network timeout before permission response')
    expect(error.isPermission).toBe(false)
    expect(new FeishuTaskError('读任务', 1470404, '不存在').isNotFound).toBe(true)
  })

  it('transfers assignees through the official member endpoints and classifies their permission and absence codes', async () => {
    const t = fixture()
    expect((await t.tasks.addAssignees('synthetic-task', ['ou_new'], 'transfer-token-0001')).assigneeOpenIds).toEqual(['ou_old', 'ou_new'])
    expect(t.api.addMembers).toHaveBeenCalledWith({ path: { task_guid: 'synthetic-task' }, params: { user_id_type: 'open_id' },
      data: { members: [{ id: 'ou_new', type: 'user', role: 'assignee' }], client_token: 'transfer-token-0001' } })
    expect((await t.tasks.removeAssignees('synthetic-task', ['ou_old'])).assigneeOpenIds).toEqual(['ou_new'])
    expect(t.api.removeMembers).toHaveBeenCalledWith({ path: { task_guid: 'synthetic-task' }, params: { user_id_type: 'open_id' },
      data: { members: [{ id: 'ou_old', type: 'user', role: 'assignee' }] } })
    t.api.addMembers.mockResolvedValueOnce({ code: 99991672, msg: 'task:personnel:writeonly required', data: {} } as never)
    await expect(t.tasks.addAssignees('synthetic-task', ['ou_new'])).rejects.toMatchObject({ isPermission: true, blocksAllCapabilities: false })
    t.api.removeMembers.mockRejectedValueOnce({ response: { data: { code: 1470404, msg: 'not found' } } })
    await expect(t.tasks.removeAssignees('synthetic-task', ['ou_old'])).rejects.toMatchObject({ isNotFound: true })
    expect(new FeishuTaskError('读任务', 99991663, 'invalid token').blocksAllCapabilities).toBe(true)
  })
})
