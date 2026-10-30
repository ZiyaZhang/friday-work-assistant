import { z } from 'zod'
import type { Capability } from './tokens.js'
import { PollAccessError, type PollRunRef, type PollRuntime } from '../core/poll-runtime.js'
import { PollError } from '../core/polls.js'

const schemas = {
  create: z.object({ question: z.string().min(1), choices: z.array(z.string().min(1)).min(2), closesAt: z.number().int().nonnegative().optional(), feedbackId: z.number().int().positive().optional() }).strict(),
  list: z.object({}).strict(), read: z.object({ pollId: z.string().min(1) }).strict(), close: z.object({ pollId: z.string().min(1) }).strict(),
}
/** No ballot route: a model cannot act as a named human voter. */
export function createPollRoutes<C extends Capability>(deps: { runtime?: PollRuntime
  requireRun(cap: C, scope: 'polls:read' | 'polls:write'): PollRunRef; assertCurrent(cap: C): void; error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  const routes: Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> = {}
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) routes[`POST /v1/polls/${operation}`] = async (cap, body) => {
    const ref = deps.requireRun(cap, operation === 'list' || operation === 'read' ? 'polls:read' : 'polls:write')
    if (!deps.runtime) throw deps.error(503, '投票协作尚未接入，没有创建或发送投票。')
    const parsed = schemas[operation].safeParse(body)
    if (!parsed.success) throw deps.error(400, '投票参数无效；不能传入投票人身份、批准状态或来源。')
    let result: unknown
    try {
      switch (operation) {
        case 'create': result = await deps.runtime.create(ref, schemas.create.parse(parsed.data)); break
        case 'list': result = await deps.runtime.list(ref); break
        case 'read': result = await deps.runtime.read(ref, schemas.read.parse(parsed.data)); break
        case 'close': result = await deps.runtime.close(ref, schemas.close.parse(parsed.data)); break
      }
    } catch (error) {
      if (error instanceof PollAccessError) throw deps.error(error.status === 'unavailable' ? 503 : 403, error.message)
      if (error instanceof PollError) throw deps.error(error.code === 'denied' ? 403 : error.code === 'not_found' ? 404 : ['invalid', 'too_large', 'snapshot_too_large'].includes(error.code) ? 400 : 409, error.message)
      throw error
    }
    deps.assertCurrent(cap); return result
  }
  return routes
}
