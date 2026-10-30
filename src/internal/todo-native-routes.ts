import { z } from 'zod'
import type { FeishuTaskSync } from '../core/feishu-task-sync.js'
import { todoTag, type Todos, type TodoAudience } from '../core/todos.js'
import { FeishuTaskError } from '../feishu/tasks.js'
import { providerAccessFailure } from '../core/access-failure.js'
import type { Capability } from './tokens.js'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const schemas = {
  resolve: z.object({ id, keep: z.enum(['friday', 'feishu']) }).strict(),
  reconcile: z.object({ id, task_url: z.string().min(1).max(4096) }).strict(),
  'abandon-create': z.object({ id }).strict(),
}
/** A task link is only an exact GUID locator. The application reads that GUID
 * and checks its original operation marker/assignee before recording a match. */
function taskGuid(value: string): string | undefined {
  let url: URL
  try { url = new URL(value) } catch { return }
  if (/[\s\\]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    !['applink.feishu.cn', 'applink.larksuite.com'].includes(url.hostname) || url.pathname !== '/client/todo/detail') return
  const values = url.searchParams.getAll('guid')
  return values.length === 1 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values[0]!) ? values[0] : undefined
}
const decisionPointer = (sync: FeishuTaskSync, id: number) => {
  const { link, pending } = sync.status(id)
  return JSON.stringify({ link: link ? { guid: link.guid, generation: link.generation, deletedAt: link.deletedAt,
    ownerOpenId: link.ownerOpenId, issue: link.issue } : null, operation: pending?.id ?? null })
}

export function createTodoNativeRoutes<C extends Capability>(deps: {
  todos: Todos
  taskSync?: FeishuTaskSync
  /** Host enforces todo:write, derived-state permission, a real human task Run
   * and its live source/Space authority. No identity is accepted from the body. */
  requireCurrent(cap: C): { audience: TodoAudience; assertCurrent(): void }
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  const routes: Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> = {}
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
    routes[`POST /v1/todo/native/${operation}`] = async (cap, body) => {
      const lease = deps.requireCurrent(cap), audience = { ...lease.audience }
      if (!audience.openId || audience.openId !== cap.requesterOpenId) throw deps.error(403, '原生待办的处理需要当前本人操作。')
      const parsed = schemas[operation].safeParse(body)
      if (!parsed.success) throw deps.error(400, '待办处理参数无效；请使用当前事项和用户明确给出的处理方式。')
      const id = parsed.data.id, sync = deps.taskSync
      if (!sync) throw deps.error(503, '飞书原生任务同步尚未启用；本次没有改变同步记录。')
      const visible = () => {
        lease.assertCurrent()
        const todo = deps.todos.getForAudience(id, audience)
        if (!todo) throw deps.error(404, '当前会话没有这条待办。')
        if (!todo.confirmed) throw deps.error(409, '这条还是候选待办，请先由本人确认，再处理飞书任务同步。')
        return todo
      }
      const before = visible(), tag = todoTag(before), pointer = decisionPointer(sync, id), issue = sync.link(id)?.issue
      const assertCurrent = () => {
        const latest = visible()
        if (todoTag(latest) !== tag || decisionPointer(sync, id) !== pointer) throw deps.error(409, '这条待办或原同步操作已变化，请先查看当前状态再决定。')
      }
      let applied = false, note: string
      try {
        if (operation === 'resolve') {
          const { keep } = schemas.resolve.parse(parsed.data)
          applied = await sync.resolveConflict(id, keep, assertCurrent)
          note = !applied ? '当前没有需要选择的冲突，或飞书那边的负责人、内容暂不能按这个选择处理。'
            : issue?.reason === 'remote_missing' ? keep === 'feishu' ? '已接受飞书中的删除，本地待办已取消。' : '已登记保留 Friday 的内容；下一轮会新建一条飞书任务。'
            : before.status === 'cancelled' ? keep === 'feishu' ? '本地待办已重新打开，保留飞书任务；下一轮采用飞书的内容。' : '已登记以 Friday 为准；飞书任务会随下一轮同步删除。'
            : keep === 'friday' ? '已登记以 Friday 为准；下一轮把 Friday 当前内容同步到飞书。' : '已登记以飞书为准；下一轮采用飞书当前内容。'
        } else if (operation === 'reconcile') {
          const guid = taskGuid(schemas.reconcile.parse(parsed.data).task_url)
          if (!guid) throw deps.error(400, '请提供飞书任务的详情链接，链接中需要包含有效的任务标识。')
          applied = await sync.reconcileCreation(id, guid, assertCurrent)
          note = applied ? '已核对原创建标记和负责人，并关联这条飞书任务；没有重复创建。'
            : '未能把这条链接核对为原来创建的任务；保留原操作继续核对，没有重新创建。'
        } else {
          applied = sync.abandonCreation(id, assertCurrent)
          note = applied ? '已按你确认飞书里没有这条任务的决定，解除原创建占位；下一轮会重新创建。如果原来那条其实已经存在，会出现两条。'
            : '当前没有可以解除的未知创建操作；没有重新创建。'
        }
      } catch (error) {
        // Recheck authority before presenting provider failures; no unknown write
        // is converted into an abandoned operation or a second creation.
        visible()
        if (error instanceof FeishuTaskError) {
          if (error.blocksAllCapabilities) throw deps.error(503, `应用访问凭证暂不可用，请管理员检查应用配置（code=${error.code}）；原操作保留，不需要重新个人授权。`)
          if (error.isPermission) throw deps.error(403, `应用缺少飞书任务权限，请管理员检查后台权限及发布状态（code=${error.code}）；个人授权不能代替应用权限。`)
          if (error.isResourceDenied) throw deps.error(403, 'Friday 没有这条飞书任务的访问权；原操作保留，请核对任务访问范围。')
          if (error.isNotFound) throw deps.error(404, '没有找到这条飞书任务；原创建操作仍保留，不能据此自动重建。')
          if (error.isRateLimited) throw deps.error(503, '飞书暂时限制请求频率；原操作保留，稍后再核对。')
          throw deps.error(409, `飞书暂未完成这次核对（code=${error.code}）；原操作保留。`)
        }
        if (providerAccessFailure(error, 'app')?.reason === 'service_unavailable') throw deps.error(503, '飞书服务或网络暂时不可用；原操作保留，请稍后继续核对，不要重新创建。')
        throw error
      }
      const todo = visible()
      return { ok: true, applied, todo, native: sync.view(todo), note }
    }
  }
  return routes
}
