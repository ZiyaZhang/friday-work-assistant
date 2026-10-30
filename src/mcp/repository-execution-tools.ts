import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerRepositoryExecutionTools(server: Pick<McpServer, 'registerTool'>,
  call: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>,
  errorResult: (error: unknown) => { content: { type: 'text'; text: string }[]; isError: boolean }) {
  const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  server.registerTool('github_run_change_check', { title: '在服务端验证修改',
    description: '对当前 Work 的精确 Git tree 在独立远端环境执行构建或测试，返回持久执行编号。queued/running 不代表完成；之后查原编号。断线或未知结果不得重复新建。命令不会在 Friday 网关或个人 Mac 上执行。' +
      '要运行仓库的生成脚本并取回它改动的文件时，传 capture.paths（相对路径，文件或目录前缀）：命令退出码为 0 且改动全部位于这些路径内时，结果里 output.state=ready 并给出 artifact.digest；范围外改动、链接、非文本或超限会整体拒绝，不会截断。生成运行不是验证通过。',
    inputSchema: { changeId: z.string(), expectedSnapshot: z.string(), command: z.string(), timeoutMs: z.number().int().min(1000).max(720_000).default(300_000),
      capture: z.object({ paths: z.array(z.string()).min(1).max(64).describe('允许回传的仓库相对路径（文件或目录前缀）'),
        maxBytes: z.number().int().min(1).max(2 * 1024 * 1024).optional().describe('补丁字节上限，默认 2 MiB') }).optional()
        .describe('仅生成脚本需要：声明允许导出的改动范围') },
  }, async input => { try { return content(await call('/v1/github/execution/start', input)) } catch (error) { return errorResult(error) } })
  for (const operation of ['read', 'stop'] as const) server.registerTool(`github_${operation}_change_check`, {
    title: operation === 'read' ? '核对原验证结果' : '停止这次验证',
    description: operation === 'read' ? '读取原服务端执行记录，核对当前修改是否仍为被测 tree。只有 validation=passed 且销毁已确认才可称本次命令通过；stale、截断或未知都要明确。带 capture 的生成运行在 output 中给出生成结果状态。'
      : '停止指定服务端验证，保留原回执。stopping / cleanup pending 时不能宣称所有进程已经停止。',
    inputSchema: { id: z.string(), changeId: z.string() },
  }, async input => { try { return content(await call(`/v1/github/execution/${operation}`, input)) } catch (error) { return errorResult(error) } })
  server.registerTool('github_apply_change_check_output', { title: '导入服务端生成结果',
    description: '把带 capture 的 github_run_change_check 生成运行（output.state=ready）产生的文件改动导入原修改副本。只接受：执行已结束且清理已确认、命令退出码 0、当前副本仍是该运行的输入 tree（expectedSnapshot 传运行时的快照）、artifactDigest 与回执一致。' +
      '网关按回执下载并核对补丁，在隔离索引中重建结果 tree，再逐文件核对原内容后写入；返回新 snapshot 与改动文件。导入后须对新 snapshot 重新运行 github_run_change_check 验证，再用 github_update_pr 追加到同一个 PR。' +
      '导入中断或冲突时，该修改副本的读写、验证和发布都会暂停，用同样参数再次调用本工具核对并继续。',
    inputSchema: { id: z.string().describe('生成运行的执行编号'), changeId: z.string(), expectedSnapshot: z.string().describe('生成运行的输入快照'),
      artifactDigest: z.string().describe('该运行 output.artifact.digest') },
  }, async input => { try { return content(await call('/v1/github/execution/apply', input)) } catch (error) { return errorResult(error) } })
}
