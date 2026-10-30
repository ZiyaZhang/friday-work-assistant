import { z } from 'zod'
import { RepositoryFiles, RepositoryFileError, type RepositoryFileIdentity, type RepositoryFileAccess } from '../github/repository-files.js'
import { ChangeAccessError, type ChangeManager } from '../github/changes.js'
import { RepositoryExecutionError } from '../github/executions.js'

const fields = { changeId: z.string().min(1).max(128), path: z.string().max(4096) }
const readConsistency = { consistency: z.enum(['files', 'snapshot']).default('files'), expectedSnapshot: z.string().optional() }
const schemas = {
  list: z.object({ changeId: fields.changeId, path: fields.path.optional(), after: z.string().optional(),
    ...readConsistency, expectedDirectoryVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  read: z.object({ ...fields, ...readConsistency }).strict(),
  'read-many': z.object({ changeId: fields.changeId, paths: z.array(fields.path).min(1).max(16), ...readConsistency }).strict(),
  search: z.object({ changeId: fields.changeId, path: fields.path.optional(), query: z.string().min(1).max(4096).optional(), queries: z.array(z.string().min(1).max(4096)).min(1).max(8).optional(),
    mode: z.enum(['content', 'path']).optional(), cursor: z.string().min(1).max(65536).optional(), limit: z.number().int().min(1).max(200).optional(), ...readConsistency }).strict().refine(value => (value.query !== undefined) !== (value.queries !== undefined)),
  write: z.object({ ...fields, expectedSnapshot: z.string(), expectedDigest: z.string().nullable(), content: z.string().nullable() }).strict(),
  edit: z.object({ ...fields, expectedSnapshot: z.string(), expectedDigest: z.string(), oldText: z.string().min(1), newText: z.string() }).strict(),
}
export function createRepositoryFileRoutes<C>(deps: {
  changes?: ChangeManager
  requireRun(cap: C, write: boolean): RepositoryFileIdentity
  authorize(cap: C, access: RepositoryFileAccess): Promise<{ assertCurrent(): void }>
  recordRead(cap: C, repo: string): void
  error(status: number, message: string): Error
}): Record<string, (cap: C, body: Record<string, unknown>) => Promise<unknown>> {
  return Object.fromEntries((Object.keys(schemas) as (keyof typeof schemas)[]).map(operation => [
    `POST /v1/github/change/files/${operation}`, async (cap: C, body: Record<string, unknown>) => {
      const actor = deps.requireRun(cap, operation === 'write' || operation === 'edit')
      if (!deps.changes) throw deps.error(503, '仓库修改服务尚未配置')
      const parsed = schemas[operation].safeParse(body)
      if (!parsed.success) throw deps.error(400, '需要已登记的修改编号和相对文件路径；不能指定执行身份或任意目录')
      const files = new RepositoryFiles({ changes: deps.changes, authorize: (_identity, access) => deps.authorize(cap, access),
        recordRead: (_identity, source) => { actor.assertAuthorized(); deps.recordRead(cap, source.repo) } })
      try {
        if (operation === 'list') return await files.list(actor, schemas.list.parse(parsed.data))
        if (operation === 'read') return await files.read(actor, schemas.read.parse(parsed.data))
        if (operation === 'read-many') return await files.readMany(actor, schemas['read-many'].parse(parsed.data))
        if (operation === 'search') {
          const search = schemas.search.parse(parsed.data)
          return search.queries ? await files.searchMany(actor, { ...search, queries: search.queries })
            : await files.search(actor, { ...search, query: search.query! })
        }
        if (operation === 'edit') return await files.edit(actor, schemas.edit.parse(parsed.data))
        return await files.write(actor, schemas.write.parse(parsed.data))
      } catch (error) {
        if (error instanceof ChangeAccessError) throw deps.error(403, error.message)
        // An unsettled execution-output import pauses this change until it is reconciled.
        if (error instanceof RepositoryExecutionError) throw deps.error(409, error.message)
        if (error instanceof RepositoryFileError) throw deps.error(
          ['invalid_request', 'unsafe_path', 'too_large', 'not_text'].includes(error.code) ? 400 : error.code === 'not_found' ? 404 : 409, error.message)
        throw error
      }
    },
  ]))
}
