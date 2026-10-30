import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerGitHubIssueFollowupTools(server: Pick<McpServer,'registerTool'>,
  call: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>,
  errorResult: (error: unknown) => { content: { type: 'text'; text: string }[]; isError: boolean }) {
  server.registerTool('github_issue_followup', { title: '跟进原反馈的 Issue 回复',
    description: '只在当前真人明确委托持续跟进时，对同一工作的已确认 Issue 登记评论跟进。start 首次以当前完整线程为基线，不补发历史评论；有新的人类评论时，宿主只读解读并回到原会话附链接，不自动在 GitHub 发言或改代码。后续新指令或停止会使旧委托失效，明确继续时再 start；已有登记不因读 Issue 自动续订。stop 仅撤回本工作的评论跟进，不关闭 Issue，也不影响其他工作的订阅。返回登记事实，不代表问题已解决。',
    inputSchema: z.object({ repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),number:z.number().int().positive(),action:z.enum(['start','stop']) }).strict(),
  }, async args => { try { return { content:[{ type:'text' as const,text:JSON.stringify(await call('/v1/github/issue/followup',args)) }] } }
    catch (error) { return errorResult(error) } })
}
