import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerTodoNativeTools(server: Pick<McpServer, 'registerTool'>,
  call: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>,
  errorResult: (error: unknown) => { content: { type: 'text'; text: string }[]; isError: boolean }) {
  const id = z.number().int().positive().describe('当前会话待办列表返回的事项 id'),
    result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  server.registerTool('friday_todo_native_resolve', {
    title: '按用户选择处理待办同步冲突',
    description: '只有用户明确说以 Friday 或飞书哪边为准时才调用；不要自行选择。保留 Friday 会把当前本地内容同步出去，若飞书已删除会重新创建；保留飞书会采用其内容或删除事实。取消冲突保留 Friday 会删除飞书任务，保留飞书会重开本地。此调用登记选择，不代表后续平台写入已完成。',
    inputSchema: { id, keep: z.enum(['friday', 'feishu']).describe('用户明确选择的一方') },
  }, async args => { try { return result(await call('/v1/todo/native/resolve', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('friday_todo_native_reconcile', {
    title: '核对用户提供的飞书任务链接',
    description: '创建回执不明时，仅用用户提供的实际飞书任务链接核对原操作。宿主检查真实任务标记及原负责人；不会按相似标题绑定，也不会重新创建。核对失败或结果未知时保留原操作，不推断平台上没有任务。',
    inputSchema: { id, task_url: z.string().describe('用户提供的飞书任务详情链接') },
  }, async args => { try { return result(await call('/v1/todo/native/reconcile', args)) } catch (error) { return errorResult(error) } })
  server.registerTool('friday_todo_native_abandon_create', {
    title: '按用户确认解除未知创建占位',
    description: '仅在用户明确确认飞书中不存在原任务、决定重新创建时调用。先说明：下一轮会重建，如果原任务其实已存在会重复。网络失败、查不到或模型猜测都不是用户确认；不要自行清除未知结果或新增确认布尔参数。记录保留在原操作账本。',
    inputSchema: { id },
  }, async args => { try { return result(await call('/v1/todo/native/abandon-create', args)) } catch (error) { return errorResult(error) } })
}
