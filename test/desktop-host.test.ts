import { describe, it, expect, vi } from 'vitest'
import { registerRoutes } from '../integrations/dsh/lib/host.js'

// Connection owns authentication and disposal; the plugin must register every
// endpoint through that registry, never mount a second unauthenticated server.
function routes(client: unknown) {
  const registered = new Map<string, any>()
  registerRoutes({ connection: { fetch: { register(route: any) { registered.set(route.path, route) } } } }, client)
  return registered
}
describe('DSH host Friday routes', () => {
  it('registers all endpoints under the authenticated shared API prefix', async () => {
    const client = { status: vi.fn(() => ({ state: 'connected', label: 'Alice Mac' })) }
    const all = routes(client)
    expect([...all.keys()]).toEqual(['status', 'pair', 'pair/status', 'forget', 'request', 'local/metadata', 'local/start', 'local/stop'].map(p => '/api/friday/' + p))
    for (const [path, route] of all) expect(route.methods).toEqual(path.endsWith('/status') && !path.includes('/pair/') ? ['GET'] : ['POST'])
    const response = await all.get('/api/friday/status').fetch(new Request('http://localhost/api/friday/status'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ state: 'connected', label: 'Alice Mac' })
  })
  it('does not echo provider errors or credentials into the browser, and rejects non-JSON mutations', async () => {
    const client = { request: vi.fn(async () => { throw new Error('Bearer synthetic-secret https://private.example') }) }
    const route = routes(client).get('/api/friday/request')
    const rejected = await route.fetch(new Request('http://localhost/api/friday/request', { method: 'POST', body: '{}' }))
    expect(rejected.status).toBe(400); expect(client.request).not.toHaveBeenCalled()
    const response = await route.fetch(new Request('http://localhost/api/friday/request', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'example', command: {} }) }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Friday 暂时不可用，请稍后再试。' })
  })
})
