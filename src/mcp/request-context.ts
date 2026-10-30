import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'

/** SDK cancellation belongs to one tool invocation, including concurrent tools. */
export function requestTools(server: McpServer): Pick<McpServer, 'registerTool'> & { signal(): AbortSignal | undefined } {
  const requests = new AsyncLocalStorage<AbortSignal>()
  const registerTool: McpServer['registerTool'] = (name, config, handler) => {
    // The public SDK callback has (args, extra), or just (extra) without a schema.
    // Preserve that tuple and its generic schema type; no private handlers are replaced.
    const callback = (...args: Parameters<typeof handler>) => {
      const extra = args.at(-1) as RequestHandlerExtra<ServerRequest, ServerNotification>
      return requests.run(extra.signal, () => Reflect.apply(handler, undefined, args))
    }
    return server.registerTool(name, config, callback as typeof handler)
  }
  return { registerTool, signal: () => requests.getStore() }
}
