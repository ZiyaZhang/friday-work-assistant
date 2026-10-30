import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { requestPublicEndpoint } from '../core/web-fetch.js'

export interface RemoteTool { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; readOnly: boolean }
export interface RemoteMcp {
  tools(url: string, token: string, guard: () => void): Promise<RemoteTool[]>
  call(url: string, token: string, name: string, args: Record<string, unknown>, guard: () => void): Promise<{ text: string; isError: boolean }>
}
export function createRemoteMcp(proxyUrl?: string, request = requestPublicEndpoint): RemoteMcp {
  async function withClient<T>(url: string, token: string, guard: () => void, action: (client: Client) => Promise<T>) {
    const target = new URL(url), deadline = AbortSignal.timeout(25_000)
    const transport = new StreamableHTTPClientTransport(target, { reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (raw, init) => {
        guard(); deadline.throwIfAborted()
        if (String(raw) !== target.toString()) throw new Error('MCP endpoint changed')
        // The optional unsolicited SSE channel is not needed for bounded calls.
        if (init?.method === 'GET') return new Response(null, { status: 405 })
        if (!['POST', 'DELETE'].includes(init?.method ?? '')) throw new Error('Unsupported MCP method')
        const headers = new Headers(init?.headers)
        if (token) headers.set('authorization', 'Bearer ' + token)
        const response = await request(url, { method: init!.method as 'POST' | 'DELETE', headers: Object.fromEntries(headers),
          ...(init?.body ? { body: String(init.body) } : {}) }, { proxyUrl, allowedOrigin: target.origin, assertCurrent: guard,
          signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]), timeoutMs: 20_000, maxBytes: 512_000 })
        guard()
        return new Response([202, 204].includes(response.status) ? null : response.body, { status: response.status,
          headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })
      } })
    const client = new Client({ name: 'Friday', version: '1.0.0' }, { capabilities: {} })
    try { guard(); await client.connect(transport); guard(); const result = await action(client); guard(); return result }
    finally { await client.close().catch(() => {}) }
  }
  return {
    tools: (url, token, guard) => withClient(url, token, guard, async client => {
      const tools: RemoteTool[] = []; let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        guard(); const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 })
        if (token && JSON.stringify(result).includes(token)) throw new Error('Credential echoed by MCP server')
        for (const tool of result.tools) tools.push({ name: tool.name, ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description.slice(0, 1500) } : {}), inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true })
        if (tools.length > 100 || Buffer.byteLength(JSON.stringify(tools)) > 120_000) throw new Error('Too many MCP tools')
        cursor = result.nextCursor; if (!cursor) return tools
      }
      throw new Error('MCP tool catalog incomplete')
    }),
    call: (url, token, name, args, guard) => withClient(url, token, guard, async client => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20_000 })
      const text = (Array.isArray(result.content) ? result.content : []).flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
        || (result.structuredContent ? JSON.stringify(result.structuredContent) : '工具返回了无文本结果，请到原服务查看。')
      if (text.length > 24000) throw new Error('MCP result too large')
      if (token && text.includes(token)) return { text: '服务响应包含凭据信息，正文已隐藏。请到原服务核实这次操作。', isError: true }
      return { text, isError: result.isError === true }
    }),
  }
}
