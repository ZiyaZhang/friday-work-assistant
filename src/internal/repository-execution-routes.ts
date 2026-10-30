import { z } from 'zod'
import { ChangeAccessError } from '../github/changes.js'
import { RepositoryExecutionError, type RepositoryExecutions } from '../github/executions.js'
import { RepositoryFileError } from '../github/repository-files.js'
import type { RepositoryExecutionOutputIdentity, RepositoryExecutionOutputs } from '../github/execution-output.js'

const ref = z.object({ id: z.string().min(1), changeId: z.string().min(1) }).strict()
const capture = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
  maxBytes: z.number().int().min(1).max(2 * 1024 * 1024).optional() }).strict()
const start = z.object({ changeId: z.string().min(1), expectedSnapshot: z.string().regex(/^[a-f0-9]{40}$/),
  command: z.string().min(1).max(16 * 1024), timeoutMs: z.number().int().min(1000).max(12 * 60_000), capture: capture.optional() }).strict()
const apply = z.object({ id: z.string().min(1).max(128), changeId: z.string().min(1).max(128),
  expectedSnapshot: z.string().regex(/^[a-f0-9]{40}$/), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export function createRepositoryExecutionRoutes<C>(deps: {
  executions?: RepositoryExecutions
  outputs?: RepositoryExecutionOutputs
  identity(cap: C): RepositoryExecutionOutputIdentity
  recordRead(cap: C, repo: string): void
  error(status: number, message: string): Error
}) {
  const status = (error: RepositoryExecutionError) =>
    ['scope_mismatch', 'identity_required'].includes(error.code) ? 403 : error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409
  return {
    ...Object.fromEntries((['start', 'read', 'stop'] as const).map(operation => [`POST /v1/github/execution/${operation}`,
      async (cap: C, body: Record<string, unknown>) => {
        const identity = deps.identity(cap)
        if (!deps.executions) throw deps.error(503, '服务端隔离执行尚未启用；没有运行构建或测试')
        try {
          const parsed = operation === 'start' ? start.safeParse(body) : ref.safeParse(body)
          if (!parsed.success) throw deps.error(400, '需要当前修改副本、精确版本和有效执行参数')
          const result = operation === 'start' ? await deps.executions.start(identity, start.parse(parsed.data))
            : await deps.executions[operation](identity, ref.parse(parsed.data))
          identity.assertAuthorized(); deps.recordRead(cap, result.repo)
          return result
        } catch (error) {
          if (error instanceof RepositoryExecutionError) throw deps.error(status(error), error.message)
          throw error
        }
      }])),
    /** Imports a finished capture job's verified artifact into the same change. */
    'POST /v1/github/execution/apply': async (cap: C, body: Record<string, unknown>) => {
      const identity = deps.identity(cap)
      if (!deps.executions || !deps.outputs) throw deps.error(503, '服务端执行结果导入尚未启用；没有改动文件')
      try {
        const parsed = apply.safeParse(body)
        if (!parsed.success) throw deps.error(400, '需要原执行编号、修改副本、原输入快照和结果摘要')
        const result = await deps.outputs.applyOutput(identity, { executionId: parsed.data.id, changeId: parsed.data.changeId,
          expectedSnapshot: parsed.data.expectedSnapshot, artifactDigest: parsed.data.artifactDigest })
        identity.assertAuthorized(); deps.recordRead(cap, result.repo)
        return result
      } catch (error) {
        if (error instanceof RepositoryExecutionError) throw deps.error(status(error), error.message)
        if (error instanceof ChangeAccessError) throw deps.error(403, error.message)
        if (error instanceof RepositoryFileError) throw deps.error(409, error.message)
        // Filesystem errors carry host paths; only a fixed cause leaves the gateway.
        const code = (error as NodeJS.ErrnoException)?.code
        if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) throw deps.error(409, `执行结果导入的文件操作未完成（${code}）；导入记录保留，请再次调用本工具核对`)
        throw error
      }
    },
  }
}
