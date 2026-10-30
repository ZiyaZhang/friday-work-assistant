import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConsoleAuth, ConsoleAuthError } from './console-auth.js'
import { HumanSpaceAccessError } from '../core/human-space-access.js'
import { ConsoleQueries, ConsoleQueryError, type ConsoleSection } from '../core/console-queries.js'
import { consolePage, consoleCss, consoleScript } from './console-page.js'
import { ConsoleCommands } from '../core/console-commands.js'
import { ConsoleOperationError } from '../core/console-operations.js'
import { SpaceApplicationError } from '../core/space-application.js'
import { TodoApplicationError } from '../core/todo-application.js'
import { RoutineControlConflictError } from '../core/routine-application.js'
import { RoutineControlError } from '../core/routines.js'
import { HumanRunControlError } from '../core/human-run-control.js'

/** Separate human routes: never fall back to Agent bearer authentication. */
export function createConsoleRouter(auth: ConsoleAuth, queries: ConsoleQueries, commands?: ConsoleCommands) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = (req.url ?? '').split('?')[0]!
    if (path !== '/console' && !path.startsWith('/console/')) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    try {
      if (await auth.handle(req, res)) return true
      const assets: Record<string, [string, string]> = {
        '/console': ['text/html', consolePage], '/console/': ['text/html', consolePage],
        '/console/app.css': ['text/css', consoleCss], '/console/app.js': ['text/javascript', consoleScript],
      }
      if (req.method === 'GET' && assets[path]) {
        const [type, body] = assets[path]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(body); return true
      }
      const actor = auth.authenticate(req)
      const mutation = /^\/console\/api\/spaces\/([^/]+)\/operations$/.exec(path)
      if (req.method === 'POST' && mutation && commands) {
        auth.requireMutation(req, actor)
        const body = await readCommand(req)
        auth.assertCurrent(actor)
        const result = await commands.execute(actor, decodeSpace(mutation[1]!), body)
        auth.assertCurrent(actor); result.assertCurrent()
        json(res, 200, result.body); return true
      }
      if (req.method !== 'GET') throw new ConsoleQueryError(405, 'method_not_allowed', '这个入口暂不支持修改。')
      let result: { body: unknown; assertCurrent(): void }
      if (path === '/console/api/spaces') result = await queries.spaces(actor)
      else {
        const match = /^\/console\/api\/spaces\/([^/]+)\/(overview|memory|tasks|executions|project)$/.exec(path)
        if (!match) throw new ConsoleQueryError(404, 'not_found', '没有这个页面。')
        const spaceId = decodeSpace(match[1]!)
        const section = match[2] as ConsoleSection
        let options: { todoStatus: 'active' | 'done' | 'cancelled' } | undefined
        if (section === 'tasks') {
          const values = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').getAll('todoStatus')
          const todoStatus = values[0] ?? 'active'
          if (values.length > 1 || (todoStatus !== 'active' && todoStatus !== 'done' && todoStatus !== 'cancelled')) {
            throw new ConsoleQueryError(400, 'invalid_todo_status', '请选择进行中、已完成或已取消的待办。')
          }
          options = { todoStatus }
        }
        result = await queries.read(actor, spaceId, section, options)
      }
      auth.assertCurrent(actor)
      result.assertCurrent()
      json(res, 200, result.body)
    } catch (error) {
      if (error instanceof ConsoleAuthError || error instanceof HumanSpaceAccessError || error instanceof ConsoleQueryError ||
        error instanceof ConsoleOperationError || error instanceof SpaceApplicationError || error instanceof TodoApplicationError || error instanceof HumanRunControlError) {
        json(res, error.status, { code: error.code, error: error.message })
      } else if (error instanceof RoutineControlError) {
        json(res, 409, { code: error instanceof RoutineControlConflictError ? 'routine_changed' : 'routine_unavailable', error: error.message })
      } else json(res, 500, { code: 'request_failed', error: '请求未完成，请重新读取状态。' })
    }
    return true
  }
}
function decodeSpace(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new ConsoleQueryError(400, 'invalid_space', '空间地址无效。') }
}
async function readCommand(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.length
    if (byteLength > 16_384) throw new ConsoleQueryError(413, 'invalid_body', '请求内容过大。')
    chunks.push(bytes)
  }
  // A network chunk may end inside a UTF-8 code point; decode only the complete body.
  const body = Buffer.concat(chunks, byteLength).toString('utf8')
  try { return JSON.parse(body) } catch { throw new ConsoleQueryError(400, 'invalid_body', '请求需要有效的 JSON。') }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body))
}
