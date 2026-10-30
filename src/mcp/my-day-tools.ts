import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Register through requestTools so SDK cancellation retains the signed HTTP lease. */
export function registerMyDayTools(server: Pick<McpServer, 'registerTool'>,
  call: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>,
  errorResult: (error: unknown) => { content: { type: 'text'; text: string }[]; isError: boolean }) {
  server.registerTool('friday_my_day', { title: '查看我的一天',
    description: '回答“今天我有哪些事”“还有什么等我拍板”时先调用。仅在本人私聊汇总个人日历、自己负责且当前可见的待办、等待本人决定的事项。' +
      '读不到的部分按返回里的“说明”如实告诉用户：日历未连接、缺少授权或读取失败不等于今天没有日程，不能说成“今天没日程”。' +
      '不会发授权卡等待，不会修改或确认待办、提醒和决定。群来源只在本人仍可访问原群时显示，看不到的只给条数。不能指定他人的身份或空间。',
    inputSchema: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Asia/Shanghai 日期 YYYY-MM-DD；省略表示今天'),
      limit: z.number().int().min(1).max(200).optional().describe('每类最多返回条数，默认 100；覆盖信息会说明是否截断'),
    }).strict(),
  }, async args => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await call('/v1/my-day', args)) }] } }
    catch (error) { return errorResult(error) }
  })
}
