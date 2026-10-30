import { describe, expect, it, vi } from 'vitest'
import { requestPublicEndpoint } from '../src/core/web-fetch.js'
import { createRemoteMcp } from '../src/personal/mcp-transport.js'

describe('pinned MCP transport', () => {
  it('uses the SDK initialization and tool protocols without offering roots or agent capabilities', async () => {
    const requests: { method: string; body: any }[] = []
    const request: typeof requestPublicEndpoint = async (url, input, options) => {
      expect(url).toBe('https://mcp.example.com/mcp'); expect(options?.allowedOrigin).toBe('https://mcp.example.com')
      expect(input.headers.authorization).toBe('Bearer synthetic-token')
      const body = JSON.parse(input.body!); requests.push({ method: input.method, body })
      if (!('id' in body)) return { status: 202, headers: {}, body: '' }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'visible result' }] }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }
    }
    const remote = createRemoteMcp(undefined, request), guard = vi.fn()
    expect(await remote.tools('https://mcp.example.com/mcp', 'synthetic-token', guard)).toMatchObject([{ name: 'search', readOnly: true }])
    expect(await remote.call('https://mcp.example.com/mcp', 'synthetic-token', 'search', { query: 'one' }, guard)).toEqual({ text: 'visible result', isError: false })
    expect(requests.find(r => r.body.method === 'initialize')!.body.params.capabilities).toEqual({})
    expect(requests.find(r => r.body.method === 'tools/call')!.body.params).toEqual({ name: 'search', arguments: { query: 'one' } })
    expect(guard).toHaveBeenCalled()
  })
  it('does not disclose credentials echoed in a remote catalog or result', async () => {
    const request: typeof requestPublicEndpoint = async (_url, input) => {
      const body = JSON.parse(input.body!)
      if (!('id' in body)) return { status: 202, headers: {}, body: '' }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'search', description: 'synthetic-secret', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'got synthetic-secret' }] }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }
    }
    const remote = createRemoteMcp(undefined, request)
    await expect(remote.tools('https://mcp.example.com/mcp', 'synthetic-secret', () => {})).rejects.toThrow('Credential echoed')
    const result = await remote.call('https://mcp.example.com/mcp', 'synthetic-secret', 'search', {}, () => {})
    expect(result.isError).toBe(true); expect(result.text).not.toContain('synthetic-secret')
  })
  it('blocks private hosts before transmitting a body and never follows a credential-bearing redirect', async () => {
    const input = { method: 'POST' as const, headers: { authorization: 'Bearer synthetic-secret' }, body: '{"private":"material"}' }
    const request = vi.fn(async () => ({ status: 302, headers: { location: 'https://other.example/collect' }, body: '' }))
    await expect(requestPublicEndpoint('https://mcp.example.com/mcp', input, { request, resolve: async () => [{ address: '127.0.0.1' }] })).rejects.toThrow('内网')
    expect(request).not.toHaveBeenCalled()
    await expect(requestPublicEndpoint('https://mcp.example.com/mcp', input, { request, resolve: async () => [{ address: '1.1.1.1' }] })).rejects.toThrow('跳转')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]).toEqual(['https://mcp.example.com/mcp', expect.objectContaining({ address: '1.1.1.1', ...input })])
  })
  it('does not dispatch after the grant is revoked while DNS resolves', async () => {
    let active = true
    const request = vi.fn(), guard = () => { if (!active) throw new Error('revoked') }
    await expect(requestPublicEndpoint('https://mcp.example.com/mcp', { method: 'POST', headers: {}, body: 'material' }, {
      request, assertCurrent: guard, resolve: async () => { active = false; return [{ address: '1.1.1.1' }] },
    })).rejects.toThrow('revoked')
    expect(request).not.toHaveBeenCalled()
  })
})
