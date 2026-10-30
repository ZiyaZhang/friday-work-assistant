import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export type IssueAssessmentToolOperation = 'assess' | 'get' | 'execute'
/** Read-only assembly (P3-3a) registers only these; `execute` is opted in by the root in P3-3b. */
export const READ_ONLY_ISSUE_ASSESSMENT_TOOLS: readonly IssueAssessmentToolOperation[] = ['assess', 'get']

export function registerIssueAssessmentTools(server: Pick<McpServer, 'registerTool'>,
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>, errorResult: (error: unknown) => CallToolResult,
  operations: readonly IssueAssessmentToolOperation[] = READ_ONLY_ISSUE_ASSESSMENT_TOOLS): void {
  const enabled = new Set(operations)
  const invoke = async (operation: string, body: Record<string, unknown>): Promise<CallToolResult> => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await call(`/v1/github/assessment/${operation}`, body)) }] } }
    catch (error) { return errorResult(error) }
  }
  if (enabled.has('assess')) server.registerTool('github_assess_issue', { title: '评估是否接手 Issue',
    description: '只在用户明确要求评估某条 Issue 时调用。读取当前群已绑定仓库（负责人用 friday_watch_issues 绑定）的完整 Issue 线程，在独立无工具评估中形成建议、待补信息或不接理由，并保存结论与逐字引文。不能指定另一个仓库、身份或执行许可；不写 GitHub、不发评论、不建待办。推荐不是修复完成，也不是执行授权。同一请求重复调用返回同一条记录；线程未变化时同群再问也返回已有记录，不重新评估。失败不反复评估，先用 github_get_assessment 查询原记录。',
    inputSchema: z.object({ number: z.number().int().positive() }).strict() }, args => invoke('assess', args))
  if (enabled.has('get')) server.registerTool('github_get_assessment', { title: '查询接单评估',
    description: '查看本群已保存的真实评估状态、证据和执行交接，不重新评估。不能把建议或排队状态描述为代码已修好。',
    inputSchema: z.object({ assessmentId: z.string().min(1).max(500) }).strict() }, args => invoke('get', args))
  if (enabled.has('execute')) server.registerTool('github_execute_assessment', { title: '续接获准的修复',
    description: '将已明确授权的评估交给原工作的执行队列。宿主必须核验原始修复请求或对该评估的真实批准；工具调用、仍有效的答复或评估建议本身都不是授权。不会额外授予 GitHub 发表权限。',
    inputSchema: z.object({ assessmentId: z.string().min(1).max(500) }).strict() }, args => invoke('execute', args))
}
