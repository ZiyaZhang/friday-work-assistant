import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export function registerMeetingTools(server: Pick<McpServer, 'registerTool'>,
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>, errorResult: (error: unknown) => CallToolResult): void {
  const sessionId = z.string().min(1).max(200).describe('friday_list_meetings 或参会工具返回的本次参会标识，不是会议号')
  const invoke = async (operation: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await call(`/v1/meetings/${operation}`, args)) }] } }
    catch (error) { return errorResult(error) }
  }
  server.registerTool('friday_list_meetings', { title: '查看本人委托的会议',
    description: '查看本人委托 Friday 处理的参会记录和真实状态，不是搜索所有人的会议。awaiting_admission 仅平台接受请求，不表示已经参会。',
    inputSchema: z.object({}).strict() }, args => invoke('list', args))
  server.registerTool('friday_join_meeting', { title: '申请静默参会',
    description: '在用户委托后申请静默加入指定会议。宿主会就精确会议号向发起人确认；会议号本身不授予入会权。不开麦克风、不开录制、不在会议发言。真实参会由后续事件核验；灰度不可用或等待主持人时如实说明。',
    inputSchema: z.object({ meetingNumber: z.string().regex(/^\d{9}$/).describe('真实的 9 位会议号') }).strict() }, args => invoke('join', args))
  server.registerTool('friday_leave_meeting', { title: '申请离开会议',
    description: '本人确认后让 Friday 离开已登记的会议，不结束其他人的会议。原动作结果未知时先核对，不重复发起。',
    inputSchema: z.object({ sessionId }).strict() }, args => invoke('leave', args))
  server.registerTool('friday_sync_meeting', { title: '核对参会状态',
    description: '只读核对平台实际参与和事件，保留分页进度。目录缺失不等于离会；平台响应失败不等于会议结束。',
    inputSchema: z.object({ sessionId }).strict() }, args => invoke('sync', args))
  server.registerTool('friday_read_meeting', { title: '读取已取得的会议事件',
    description: '只在委托人私聊读取本次已核验会议事件和转写。沿 nextOffset 读完整保留范围；转写缺失须说明，不编造录音或完整覆盖。shared URL 只是会议资料里的链接，不是额外读取授权。',
    inputSchema: z.object({ sessionId, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() }, args => invoke('read', args))
  server.registerTool('friday_propose_meeting_draft', { title: '交付会后待审稿',
    description: '把基于实际会议事件的完整纪要和行动项送给本人确认。全文发送成功后才提供确认卡；本工具不创建待办。本人接受后记录行动，涉及他人的事项仍是候选。每个 action.detail 最多 2000 字符；不要省略审阅所需内容来硬塞限制，可整理到 summary。',
    inputSchema: z.object({ sessionId, summary: z.string().min(1).max(100_000), actions: z.array(z.object({ title: z.string().min(1).max(200),
      detail: z.string().max(2000).optional(), owner: z.string().min(1).max(200).optional(), ownerOpenId: z.string().min(1).max(200).optional(),
      dueMs: z.number().int().nonnegative().max(8.64e15).optional() }).strict()).max(100) }).strict() }, args => invoke('draft/propose', args))
}
