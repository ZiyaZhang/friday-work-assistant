import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export function registerPollTools(server: Pick<McpServer, 'registerTool'>,
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>, errorResult: (error: unknown) => CallToolResult): void {
  const invoke = async (operation: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await call(`/v1/polls/${operation}`, args)) }] } }
    catch (error) { return errorResult(error) }
  }
  const pollId = z.string().min(1).describe('本空间投票工具返回的内部引用；对用户使用投票问题称呼，不展示编号')
  server.registerTool('friday_create_poll', { title: '发起需求投票', description: '原群负责人发起完整问题和选项的具名单选投票。由真实用户点击原群卡片，模型不能代投。关闭前可以改票或撤票。内容太长会明确拒绝，不会截断。投票不自动创建 Issue 或执行获选方案。',
    inputSchema: z.object({ question: z.string().min(1), choices: z.array(z.string().min(1)).min(2), closesAt: z.number().int().nonnegative().optional().describe('明确截止时间的毫秒时间戳；0 或省略不自动截止，不推测期限'), feedbackId: z.number().int().positive().optional().describe('可选：当前空间已有反馈的引用') }).strict() }, args => invoke('create', args))
  server.registerTool('friday_list_polls', { title: '查看本群投票', description: '在原群查看已发布投票，遵守当前来源权限；不会扩大到其他空间。', inputSchema: z.object({}).strict() }, args => invoke('list', args))
  server.registerTool('friday_read_poll', { title: '读取投票结果', description: '读取本群投票的实际具名分类和票数。未截止结果仍可变化；不得把参加者票数说成全体成员意见。', inputSchema: z.object({ pollId }).strict() }, args => invoke('read', args))
  server.registerTool('friday_close_poll', { title: '关闭投票并汇总', description: '原群负责人关闭投票，冻结实际选择并在原群交付完整分类，关联反馈等待负责人决断。不自动建 Issue，不替人作产品决策。', inputSchema: z.object({ pollId }).strict() }, args => invoke('close', args))
}
