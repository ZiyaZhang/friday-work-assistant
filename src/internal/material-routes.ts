import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MaterialApplicationError, type ExecutionMaterialApplication } from '../core/execution-material-application.js'
import { ExecutionMaterialError } from '../core/execution-materials.js'
import type { Capability } from './tokens.js'

const file = z.object({ fileId: z.string().min(1), expectedDigest: z.string().regex(/^[0-9a-f]{64}$/) })
const schemas = {
  list: z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(),
  read: file.extend({ startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
    maxBytes: z.number().int().min(1).max(1024 * 1024).optional() }).strict(),
  search: z.object({ files: z.array(file.strict()).min(1).max(100), query: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(500).optional() }).strict(),
  write: z.object({ name: z.string().min(1).max(240), text: z.string().max(1024 * 1024) }).strict(),
  edit: file.extend({ edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict()).min(1).max(100) }).strict(),
  send: file.extend({ note: z.string().max(500).optional() }).strict(),
  'zip/list': file.extend({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
  'zip/extract': file.extend({ members: z.array(z.string().min(1).max(1024)).min(1).max(100) }).strict(),
  'zip/pack': z.object({ name: z.string().min(1).max(240),
    files: z.array(file.extend({ member: z.string().min(1).max(1024).optional() }).strict()).min(1).max(100) }).strict(),
}

/** Signed Run identity is supplied by the HTTP host, never accepted in tool arguments. */
export function createMaterialRoutes<C extends Capability>(deps: {
  application?: ExecutionMaterialApplication
  requireRun(cap: C, scope: 'file:read' | 'file:write' | 'file:send'): string
  assertCurrent(cap: C): void
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  const routes: Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> = {}
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
    routes[`POST /v1/files/${operation}`] = async (cap, body) => {
      if (operation === 'zip/extract' || operation === 'zip/pack') deps.requireRun(cap, 'file:read')
      const runId = deps.requireRun(cap, operation === 'send' ? 'file:send' : ['write', 'edit', 'zip/extract', 'zip/pack'].includes(operation) ? 'file:write' : 'file:read')
      if (!deps.application) throw deps.error(503, '本次执行尚未接入文件操作。')
      const parsed = schemas[operation].safeParse(body)
      if (!parsed.success) throw deps.error(400, '文件参数无效，请使用本次返回的文件编号和摘要。')
      // Stable across retries/Runs in this business session. The store also scopes the
      // identity to its actual host-owned material generation.
      const operationKey = createHash('sha256').update(JSON.stringify([cap.sessionKey, operation, parsed.data])).digest('hex')
      let result: unknown
      try {
        const app = deps.application
        switch (operation) {
          case 'list': result = await app.list(runId, schemas.list.parse(parsed.data)); break
          case 'read': result = await app.read(runId, schemas.read.parse(parsed.data)); break
          case 'search': result = await app.search(runId, schemas.search.parse(parsed.data)); break
          case 'write': result = await app.write(runId, schemas.write.parse(parsed.data), operationKey); break
          case 'edit': result = await app.edit(runId, schemas.edit.parse(parsed.data), operationKey); break
          case 'send': result = await app.send(runId, schemas.send.parse(parsed.data)); break
          case 'zip/list': result = await app.zipList(runId, schemas['zip/list'].parse(parsed.data)); break
          case 'zip/extract': result = await app.zipExtract(runId, schemas['zip/extract'].parse(parsed.data), operationKey); break
          case 'zip/pack': result = await app.zipPack(runId, schemas['zip/pack'].parse(parsed.data), operationKey); break
        }
      } catch (error) {
        if (!(error instanceof ExecutionMaterialError) && !(error instanceof MaterialApplicationError)) throw error
        const status = error.code === 'denied' ? 403 : error.code === 'not_found' ? 404 : error.code === 'archive_limit' ? 413
          : ['invalid_request', 'not_text', 'invalid_archive', 'unsafe_archive', 'encrypted_archive', 'archive_member_missing'].includes(error.code) ? 400 : 409
        throw deps.error(status, error.message)
      }
      deps.assertCurrent(cap)
      return result
    }
  }
  return routes
}
