import { describe, expect, it } from 'vitest'
import { executorConfig } from '../src/config.js'
import { ExecutorClient } from '../src/github/executor-client.js'

const secret = 'synthetic-executor-only-secret-value'
describe('remote execution configuration', () => {
  it('stays disabled without an executor and never borrows another service credential', () => {
    expect(executorConfig({})).toBeUndefined()
    expect(executorConfig({ FRIDAY_OAUTH_RELAY_TOKEN: secret, GITHUB_TOKEN: secret })).toBeUndefined()
  })
  it('requires a fixed HTTPS endpoint and independent credential without exposing input in errors', () => {
    for (const env of [
      { FRIDAY_EXECUTOR_URL: 'https://executor.example' },
      { FRIDAY_EXECUTOR_TOKEN: secret },
      ...['http://executor.example', 'https://executor.example/?token=private',
        'https://user:private@executor.example', 'not-a-url'].map(FRIDAY_EXECUTOR_URL => ({ FRIDAY_EXECUTOR_URL, FRIDAY_EXECUTOR_TOKEN: secret })),
      ...['short', 'bad\nvalue'.repeat(10), 'a'.repeat(4097)].map(FRIDAY_EXECUTOR_TOKEN => ({ FRIDAY_EXECUTOR_URL: 'https://executor.example', FRIDAY_EXECUTOR_TOKEN })),
    ]) {
      expect(() => executorConfig(env)).toThrow()
      try { executorConfig(env) } catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain('private') }
    }
  })
  it('uses a dedicated transport proxy without changing global transport', () => {
    const cfg = executorConfig({ FRIDAY_EXECUTOR_URL: 'https://executor.example/', FRIDAY_EXECUTOR_TOKEN: secret,
      FRIDAY_EXECUTOR_PROXY: 'http://proxy.example:3128' })!
    expect(cfg).toEqual({ baseUrl: 'https://executor.example', secret, proxyUrl: 'http://proxy.example:3128' })
    expect(() => new ExecutorClient(cfg)).not.toThrow()
  })

  it.each([
    ['https://executor.example', 'https://executor.example'],
    ['https://executor.example/', 'https://executor.example'],
    ['https://executor.example.com/friday-executor', 'https://executor.example.com/friday-executor'],
    ['https://executor.example.com/friday-executor/', 'https://executor.example.com/friday-executor'],
    ['https://executor.example:8443/services/v1.0/executor/', 'https://executor.example:8443/services/v1.0/executor'],
  ])('preserves the configured mount from environment to the client: %s', async (base, expected) => {
    const cfg = executorConfig({ FRIDAY_EXECUTOR_URL: base, FRIDAY_EXECUTOR_TOKEN: secret })!
    expect(cfg.baseUrl).toBe(expected)
    const sent: string[] = []
    const client = new ExecutorClient(cfg, async request => {
      sent.push(request.url)
      expect(request.redirect).toBe('error')
      expect(request.headers.authorization).toBe(`Bearer ${secret}`)
      return Response.json({ error: 'unknown_job' }, { status: 404 })
    })
    await expect(client.read('friday-config-job-1234', () => {})).rejects.toMatchObject({ code: 'not_found', result: 'read_failed' })
    expect(sent).toEqual([`${expected}/jobs/friday-config-job-1234`])
  })

  it('inherits the Feishu proxy only when no executor proxy is configured', () => {
    const base = { FRIDAY_EXECUTOR_URL: 'https://executor.example', FRIDAY_EXECUTOR_TOKEN: secret, FRIDAY_FEISHU_PROXY: 'http://feishu-proxy.example:3128' }
    expect(executorConfig(base)!.proxyUrl).toBe('http://feishu-proxy.example:3128')
    expect(executorConfig({ ...base, FRIDAY_EXECUTOR_PROXY: '' })!.proxyUrl).toBe('http://feishu-proxy.example:3128')
    expect(executorConfig({ ...base, FRIDAY_EXECUTOR_PROXY: 'http://executor-proxy.example:3128' })!.proxyUrl).toBe('http://executor-proxy.example:3128')
  })

  it.each(['direct', 'off', 'none', '0', ' Direct '])('forces a direct connection when the executor proxy is %j even if a Feishu proxy exists', value => {
    const cfg = executorConfig({ FRIDAY_EXECUTOR_URL: 'https://executor.example', FRIDAY_EXECUTOR_TOKEN: secret,
      FRIDAY_FEISHU_PROXY: 'http://feishu-proxy.example:3128', FRIDAY_EXECUTOR_PROXY: value })!
    expect(cfg.proxyUrl).toBeUndefined()
    expect(() => new ExecutorClient(cfg)).not.toThrow()
  })

  it.each([
    '/friday-executor/../private', '/friday-executor/./', '/friday-executor//private', '//private',
    '/friday-executor/%2e%2e/private', '/friday-executor/%2Fprivate', '/friday-executor/%252e%252e',
    '/friday-executor\\..\\private', '/friday-executor/?', '/friday-executor/#', '/friday-executor/\nprivate',
  ])('rejects ambiguous mount syntax in both configuration entry points: %j', path => {
    const baseUrl = `https://executor.example${path}`
    expect(() => new ExecutorClient({ baseUrl, secret })).toThrow()
    expect(() => executorConfig({ FRIDAY_EXECUTOR_URL: baseUrl, FRIDAY_EXECUTOR_TOKEN: secret })).toThrow()
    try { executorConfig({ FRIDAY_EXECUTOR_URL: baseUrl, FRIDAY_EXECUTOR_TOKEN: secret }) }
    catch (error) { expect(String(error)).not.toContain('private'); expect(String(error)).not.toContain(secret) }
  })
})
