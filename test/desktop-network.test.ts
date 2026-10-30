import { describe, it, expect, vi } from 'vitest'
import { configuredProxy, createDesktopFetch } from '../integrations/dsh/lib/network.js'

describe('desktop Friday networking', () => {
  it('uses the configured desktop HTTPS proxy without changing TLS or system settings', () => {
    const system = vi.fn(() => 'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n')
    expect(configuredProxy({ env: {}, platform: 'darwin', system })).toBe('http://127.0.0.1:7897/')
    expect(configuredProxy({ env: { HTTPS_PROXY: 'http://proxy.test:8080' }, platform: 'darwin', system })).toBe('http://proxy.test:8080/')
    expect(system).toHaveBeenCalledTimes(1)
    expect(configuredProxy({ env: {}, platform: 'darwin', system: () => 'HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n' })).toBeUndefined()
    expect(configuredProxy({ env: {}, platform: 'linux', system })).toBeUndefined()
    expect(() => configuredProxy({ env: { HTTPS_PROXY: 'file:///private' } })).toThrow('代理')
  })
  it('preserves direct requests when no proxy is configured', async () => {
    const direct = vi.fn(async () => new Response('{"ok":true}'))
    const request = createDesktopFetch({ direct, proxy: () => undefined })
    const init = { method: 'POST', redirect: 'error' as const, body: '{}' }
    expect(await (await request('https://friday.test/desktop/pair', init)).json()).toEqual({ ok: true })
    expect(direct).toHaveBeenCalledWith('https://friday.test/desktop/pair', init)
  })
})
