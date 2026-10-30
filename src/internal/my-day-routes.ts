import { z } from 'zod'
import { MyDayError, type MyDayApplication } from '../core/my-day.js'
import { renderMyDay } from '../core/personal-assistant-host.js'

const input = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(200).optional() }).strict()

/** Only the host can supply the current person, Run and private session. This
 * read never creates an authorization card or changes an underlying item. */
export function createMyDayRoutes<C>(deps: {
  myDay?: Pick<MyDayApplication, 'read' | 'assertResultCurrent'>
  requireRun(cap: C): { sessionKey: string; runId: string; assertCurrent(): void }
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  return { 'POST /v1/my-day': async (cap, body) => {
    const lease = deps.requireRun(cap)
    lease.assertCurrent()
    if (!deps.myDay) throw deps.error(503, '这个部署还没有接入个人日程和待办汇总。')
    const parsed = input.safeParse(body)
    if (!parsed.success) throw deps.error(400, '只接受有效日期和汇总条数；不能指定其他人的身份或空间。')
    try {
      const result = await deps.myDay.read({ sessionKey: lease.sessionKey, runId: lease.runId }, parsed.data)
      lease.assertCurrent(); deps.myDay.assertResultCurrent(result)
      return { result, text: renderMyDay(result, { for: 'model' }) }
    } catch (error) {
      // A request/Run that ended during I/O takes precedence over a provider gap.
      lease.assertCurrent()
      if (error instanceof MyDayError) throw deps.error(error.code === 'invalid' ? 400 : error.code === 'denied' ? 403 : 409, error.message)
      throw error
    }
  } }
}
