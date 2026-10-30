import { z } from 'zod'
import { IssueFollowupChanged, type IssueFollowupInput, type IssueFollowupView } from '../github/issue-followups.js'

const schema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), action: z.enum(['start','stop']) }).strict()
export function createGitHubIssueFollowupRoutes<C>(deps: {
  requireRun(cap: C): { sessionKey: string; runId: string }
  control?: (sessionKey: string, runId: string, input: IssueFollowupInput) => Promise<IssueFollowupView>
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  return { 'POST /v1/github/issue/followup': async (cap, body) => {
    const ref = deps.requireRun(cap), parsed = schema.safeParse(body)
    if (!parsed.success) throw deps.error(400, '需要仓库、Issue 编号和 start/stop；不能指定身份、来源或权限')
    if (!deps.control) throw deps.error(503, 'Issue 评论跟进尚未配置')
    try {
      const result = await deps.control(ref.sessionKey,ref.runId,{ ...parsed.data,repo:parsed.data.repo.toLowerCase() })
      deps.requireRun(cap); return result
    } catch (error) {
      if (error instanceof IssueFollowupChanged) throw deps.error(['binding_changed','source_unavailable'].includes(error.code) ? 403 : 409,error.message)
      throw error
    }
  } }
}
