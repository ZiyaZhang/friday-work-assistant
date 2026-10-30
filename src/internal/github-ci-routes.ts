import { z } from 'zod'
import { CiFollowupChanged, type CiControlInput, type CiControlResult } from '../github/ci-followups.js'

const schema = z.object({ change_id: z.string().min(1).max(128), expected_head: z.string().regex(/^[a-f0-9]{40,64}$/),
  action: z.enum(['continue', 'stop']), handling: z.enum(['preserve', 'notify_only', 'repair']).optional(),
  notification: z.enum(['preserve', 'completion', 'actionable']).optional() }).strict()

export function createGitHubCiRoutes<C>(deps: {
  requireRun(cap: C): { sessionKey: string; runId: string }
  authorize(cap: C, changeId: string, action: CiControlInput['action']): void
  control?: (sessionKey: string, runId: string, input: CiControlInput) => Promise<CiControlResult>
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  return { 'POST /v1/github/pr/followup': async (cap, body) => {
    const ref = deps.requireRun(cap), parsed = schema.safeParse(body)
    if (!parsed.success) throw deps.error(400, '需要真实修改编号、当前 PR 提交和跟进操作；不能指定身份或权限')
    if (!deps.control) throw deps.error(503, 'CI 跟进控制尚未配置')
    const input = parsed.data
    const assertCurrent = () => { deps.requireRun(cap); deps.authorize(cap, input.change_id, input.action) }
    assertCurrent()
    try {
      const result = await deps.control(ref.sessionKey, ref.runId, { changeId: input.change_id, expectedHead: input.expected_head,
        action: input.action, handling: input.handling, notification: input.notification })
      assertCurrent(); return result
    } catch (error) {
      if (error instanceof CiFollowupChanged) throw deps.error(error.code === 'source_unavailable' || error.code === 'binding_changed' ? 403 : 409, error.message)
      throw error
    }
  } }
}
