import { z } from 'zod'
import type { MeetingApplication, MeetingRunRef } from '../core/meeting-application.js'
import { MeetingStateError } from '../core/meeting-sessions.js'
import { MeetingProviderError } from '../feishu/meetings.js'
import { MeetingAccessError } from '../core/meeting-runtime.js'
import type { Capability } from './tokens.js'

const session = { sessionId: z.string().min(1).max(200) }
const schemas = {
  list: z.object({}).strict(),
  join: z.object({ meetingNumber: z.string().regex(/^\d{9}$/) }).strict(),
  leave: z.object(session).strict(),
  sync: z.object(session).strict(),
  read: z.object({ ...session, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  'draft/propose': z.object({ ...session, summary: z.string().min(1).max(100_000),
    actions: z.array(z.object({ title: z.string().min(1).max(200), detail: z.string().max(2000).optional(), owner: z.string().min(1).max(200).optional(),
      ownerOpenId: z.string().min(1).max(200).optional(), dueMs: z.number().int().nonnegative().max(8.64e15).optional() }).strict()).max(100) }).strict(),
}

/** Only this host adapter can convert a signed capability to a current task Run. */
export function createMeetingRoutes<C extends Capability>(deps: {
  application?: MeetingApplication
  requireRun(cap: C, scope: 'meetings:read' | 'meetings:write'): MeetingRunRef
  assertCurrent(cap: C): void
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  const routes: Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> = {}
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
    routes[`POST /v1/meetings/${operation}`] = async (cap, body) => {
      const ref = deps.requireRun(cap, ['join', 'leave', 'draft/propose'].includes(operation) ? 'meetings:write' : 'meetings:read')
      if (!deps.application) throw deps.error(503, '会议协作尚未接入；没有发起参会。')
      const parsed = schemas[operation].safeParse(body)
      if (!parsed.success) throw deps.error(400, '会议参数无效；使用实际会议号或本次返回的参会标识。')
      let result: unknown
      try {
        const app = deps.application
        switch (operation) {
          case 'list': result = app.list(ref); break
          case 'join': result = await app.join(ref, schemas.join.parse(parsed.data)); break
          case 'leave': result = await app.leave(ref, schemas.leave.parse(parsed.data)); break
          case 'sync': result = await app.sync(ref, schemas.sync.parse(parsed.data)); break
          case 'read': result = await app.read(ref, schemas.read.parse(parsed.data)); break
          case 'draft/propose': result = await app.proposeDraft(ref, schemas['draft/propose'].parse(parsed.data)); break
        }
      } catch (error) {
        if (error instanceof MeetingAccessError) throw deps.error(error.status === 'unavailable' ? 503 : 403,
          error.status === 'unavailable' ? '会议资料暂时无法核验，请稍后再试；没有重复参会或发送草稿。' : '这次会议或草稿资料的读取权限已变化，请先核对原资料范围。')
        if (error instanceof MeetingStateError) throw deps.error(error.code === 'denied' ? 403 : error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409, error.message)
        if (error instanceof MeetingProviderError) throw deps.error(error.reason === 'invalid_request' ? 400 : error.reason === 'transport' ? 503 : 409,
          `会议平台暂未完成本次请求（${error.reason}${error.code === undefined ? '' : `，${error.code}`}）。${error.reason === 'configuration' ? '请检查应用会议权限和灰度开放状态；个人授权不能代替应用配置。' : error.reason === 'conditions' ? '请检查主持人放行、会议状态或入会条件。' : '保留原记录，先核对实际状态，不要重复发起。'}`)
        throw error
      }
      deps.assertCurrent(cap)
      return result
    }
  }
  return routes
}
