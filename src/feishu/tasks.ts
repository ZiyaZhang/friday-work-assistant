/**
 * 飞书「任务」：把 Friday 记下来的事，放进人自己的任务列表里。
 *
 * 为什么值得接：待办放在飞书任务里，人才看得到。
 * Friday 的 `todos` 表再好用，也只活在 Friday 的对话里；指派、截止、原生提醒、
 * 手机上那个小红点，都在飞书任务那边。卡片里的可打勾清单是**退而求其次**的顶替。
 *
 * 归属是这里唯一要想清楚的事。飞书任务按"谁是成员"来鉴权和展示：
 * 以应用身份建的任务，**默认不会出现在任何人的任务列表里**。
 * 所以建的时候就把人加成 `assignee`——这样它在他自己的「我负责的」里，
 * 而且不需要他先做个人授权（需新版任务的应用权限 `task:task:writeonly` + `task:task:read`）。
 *
 * client_token 是平台幂等提示，不是永久去重证明；创建丢失 ACK 时由宿主账本阻止盲重发。
 */
import type { Client } from '@larksuiteoapi/node-sdk'

export interface FeishuTask {
  guid: string
  summary: string
  description?: string | null
  dueMs?: number | null
  dueIsAllDay?: boolean
  assigneeOpenIds?: readonly string[]
  /** 平台的更新时间仅作观察证据；Task v2 没有以它作条件更新的请求字段。 */
  updatedAt?: number
  extra?: string
  /** 完成时间；未完成时是 undefined */
  completedAt?: number
  url?: string
}

export interface CreateTaskInput {
  summary: string
  description?: string
  /** 截止时间（毫秒）；Task v2 接受毫秒时间戳的字符串。 */
  dueMs?: number | null
  /** 本地已经完成时随创建一并写入；Task v2 接受毫秒时间戳。 */
  completedAtMs?: number
  /** 谁负责。第一个是 assignee，其余是关注者。 */
  assigneeOpenIds?: readonly string[]
  /** 幂等键：同一条待办永远用同一个，重试不会建出第二条。 */
  clientToken: string
  /** 宿主创建收据标识，可用精确 guid 回读核对丢失的创建 ACK。 */
  extra?: string
}

export interface PatchTaskInput {
  summary?: string
  description?: string | null
  dueMs?: number | null
  completedAtMs?: number
}

/** Task v2 的 due.timestamp / completed_at 都是毫秒，不能沿用 v1 的秒单位。 */
function timestamp(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('任务时间必须是有效的毫秒时间戳')
  return String(ms)
}

export class FeishuTasks {
  constructor(private readonly client: Client) {}

  /**
   * 建一个任务，并把人加成成员。
   *
   * 成员**在建的时候就带上**，不另外调 add_members：分两步的话，
   * 第一步成功、第二步失败就会留下一个没有主人的任务——它不在任何人的列表里，
   * 谁也看不到，却已经存在了。
   */
  async create(input: CreateTaskInput): Promise<FeishuTask> {
    const members = (input.assigneeOpenIds ?? []).map((id, i) => ({
      id, type: 'user', role: i === 0 ? 'assignee' : 'follower',
    }))
    const res = await this.request(() => this.client.task.v2.task.create({
      params: { user_id_type: 'open_id' },
      data: {
        summary: input.summary.slice(0, 1000),
        ...(input.description ? { description: input.description.slice(0, 3000) } : {}),
        ...(input.dueMs !== undefined && input.dueMs !== null ? { due: { timestamp: timestamp(input.dueMs), is_all_day: false } } : {}),
        ...(input.completedAtMs !== undefined ? { completed_at: timestamp(input.completedAtMs) } : {}),
        ...(members.length ? { members } : {}),
        client_token: input.clientToken,
        ...(input.extra !== undefined ? { extra: input.extra } : {}),
      },
    }), '建任务')
    return this.taskOf(res, '建任务')
  }

  /** 标记完成 / 取消完成。`completed_at` 传 "0" 就是重新打开——这是飞书的约定，不是我们的。 */
  async setCompleted(guid: string, done: boolean, atMs = Date.now()): Promise<FeishuTask> {
    return this.patch(guid, { completedAtMs: done ? atMs : 0 })
  }

  /** 改标题 / 截止。只把真的要改的字段写进 update_fields——没列进去的飞书不会动。 */
  async patch(guid: string, patch: PatchTaskInput): Promise<FeishuTask> {
    const task: Record<string, unknown> = {}
    const fields: string[] = []
    if (patch.summary !== undefined) { task.summary = patch.summary.slice(0, 1000); fields.push('summary') }
    if (patch.description !== undefined) {
      if (patch.description !== null) task.description = patch.description.slice(0, 3000)
      fields.push('description')
    }
    if (patch.dueMs !== undefined) {
      // Task v2 clears a listed field when its new value is absent from task.
      if (patch.dueMs !== null) task.due = { timestamp: timestamp(patch.dueMs), is_all_day: false }
      fields.push('due')
    }
    if (patch.completedAtMs !== undefined) { task.completed_at = timestamp(patch.completedAtMs); fields.push('completed_at') }
    if (!fields.length) return this.get(guid)
    const res = await this.request(() => this.client.task.v2.task.patch({
      path: { task_guid: guid },
      params: { user_id_type: 'open_id' },
      data: { task: task as never, update_fields: fields },
    }), '改任务')
    return this.taskOf(res, '改任务')
  }

  async get(guid: string): Promise<FeishuTask> {
    const res = await this.request(() => this.client.task.v2.task.get({
      path: { task_guid: guid },
      params: { user_id_type: 'open_id' },
    }), '读任务')
    return this.taskOf(res, '读任务')
  }

  /**
   * 转交：把人加成负责人。官方 add_members 对已在任务里的成员自动忽略，所以同一 GUID、同一目标重复执行是安全的。
   * 需要应用权限 task:personnel:writeonly 或 task:task:write；task:task:writeonly 不包含成员增删。
   */
  async addAssignees(guid: string, openIds: readonly string[], clientToken?: string): Promise<FeishuTask> {
    const res = await this.request(() => this.client.task.v2.task.addMembers({
      path: { task_guid: guid },
      params: { user_id_type: 'open_id' },
      data: { members: openIds.map(id => ({ id, type: 'user', role: 'assignee' })), ...(clientToken ? { client_token: clientToken } : {}) },
    }), '转交任务')
    return this.taskOf(res, '转交任务')
  }

  /** 转交的第二步：移除原负责人。官方 remove_members 对不在任务里的成员自动忽略；该接口没有 client_token。 */
  async removeAssignees(guid: string, openIds: readonly string[]): Promise<FeishuTask> {
    const res = await this.request(() => this.client.task.v2.task.removeMembers({
      path: { task_guid: guid },
      params: { user_id_type: 'open_id' },
      data: { members: openIds.map(id => ({ id, type: 'user', role: 'assignee' })) },
    }), '转交任务')
    return this.taskOf(res, '转交任务')
  }

  /** No implicit cancellation mapping: callers must choose this destructive native operation explicitly. */
  async delete(guid: string): Promise<void> {
    const res = await this.request(() => this.client.task.v2.task.delete({ path: { task_guid: guid } }), '删除任务')
    const r = res as { code?: number; msg?: string }
    if (r.code !== 0) throw new FeishuTaskError('删除任务', r.code ?? -1, r.msg ?? '缺少删除确认')
  }

  /** SDK can reject HTTP 400 before returning its JSON error; retain only provider code/message. */
  private async request<T>(send: () => Promise<T>, what: string): Promise<T> {
    try { return await send() }
    catch (error) {
      const data = (error as { response?: { data?: { code?: unknown; msg?: unknown } } })?.response?.data
      if (typeof data?.code === 'number' && data.code !== 0) {
        throw new FeishuTaskError(what, data.code, typeof data.msg === 'string' ? data.msg : '')
      }
      throw error
    }
  }

  /** 统一解包：飞书的 code 非 0 要当成失败，不能让 `undefined` 一路往下走。 */
  private taskOf(res: unknown, what: string): FeishuTask {
    const r = res as { code?: number; msg?: string; data?: { task?: Record<string, unknown> } }
    if (r.code !== undefined && r.code !== 0) throw new FeishuTaskError(what, r.code, r.msg ?? '')
    const t = r.data?.task
    const guid = typeof t?.guid === 'string' ? t.guid : ''
    if (!guid) throw new FeishuTaskError(what, -1, '返回里没有任务 guid')
    const completed = typeof t?.completed_at === 'string' ? Number(t.completed_at) : 0
    const due = t?.due as { timestamp?: unknown; is_all_day?: unknown } | undefined
    const dueMs = typeof due?.timestamp === 'string' ? Number(due.timestamp) : undefined
    const updatedAt = typeof t?.updated_at === 'string' ? Number(t.updated_at) : undefined
    return {
      guid,
      summary: typeof t?.summary === 'string' ? t.summary : '',
      description: typeof t?.description === 'string' && t.description !== '' ? t.description : null,
      dueMs: Number.isSafeInteger(dueMs) ? dueMs! : null,
      dueIsAllDay: due?.is_all_day === true,
      assigneeOpenIds: Array.isArray(t?.members) ? t.members.flatMap(member => {
        const m = member as { id?: unknown; type?: unknown; role?: unknown }
        return m.type === 'user' && m.role === 'assignee' && typeof m.id === 'string' ? [m.id] : []
      }) : undefined,
      ...(Number.isSafeInteger(updatedAt) ? { updatedAt } : {}),
      ...(typeof t?.extra === 'string' ? { extra: t.extra } : {}),
      // 飞书用 "0" 表示未完成，不是 null；当成时间戳会得到 1970 年
      completedAt: Number.isSafeInteger(completed) && completed > 0 ? completed : undefined,
      url: typeof t?.url === 'string' ? t.url : undefined,
    }
  }
}

export class FeishuTaskError extends Error {
  constructor(readonly what: string, readonly code: number, readonly detail: string) {
    super(`${what}失败（code=${code}${detail ? `：${detail}` : ''}）`)
    this.name = 'FeishuTaskError'
  }

  /** 没开新版任务权限时，权限类错误不应一直重试，也不当成普通网络抖动。 */
  get isPermission(): boolean {
    // Only structured platform denials are safe to retry as an unperformed write. An arbitrary
    // error message containing “permission” must not turn a lost ACK into a second creation.
    return this.code === 99991672 || this.code === 99991663
  }
  /** 99991672 names one missing scope: only operations needing that scope stop. An invalid app
   * access token (99991663) stops every native call until the credential or permission version changes. */
  get blocksAllCapabilities(): boolean { return this.code === 99991663 }
  /** The platform refused the request as given (parameters, member limits): proven not performed. */
  get isRejectedRequest(): boolean { return this.code === 1470400 || this.code === 1470610 || this.code === 1470611 }
  /** Gateway frequency limit (99991400): not performed; every call should wait briefly. */
  get isRateLimited(): boolean { return this.code === 99991400 }
  /** Task v2 official response codes; resource denial is never evidence of deletion. */
  get isResourceDenied(): boolean { return this.code === 1470403 }
  get isNotFound(): boolean { return this.code === 1470404 }
}
