import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function config(apiUrl = 'https://api.invalid') {
  const home = mkdtempSync(join(tmpdir(), 'friday-identity-cancel-')); cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const privateKeyPath = join(home, 'test-only.pem')
  writeFileSync(privateKeyPath, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return { apiUrl, appId: 'test-app', installationId: '1', privateKeyPath, mode: 'app' as const, allowedRepos: ['org/demo'], writableRepos: ['org/demo'] }
}

describe('GitHub credential/read transport cancellation', () => {
  it('does not turn a cancelled installation lookup into configured-installation fallback or another token request', async () => {
    const controller = new AbortController(), calls: string[] = []
    const http: GitHubHttp = { request: vi.fn(async (_method, path, _body, _headers, signal) => {
      calls.push(path); expect(signal).toBe(controller.signal); controller.abort(new Error('request cancelled')); throw new Error('network aborted')
    }) }
    const log = createLogger('test', 'error'), warn = vi.spyOn(log, 'warn')
    const identity = new GitHubIdentity(config(), log, http)
    await expect(identity.token('org', controller.signal)).rejects.toThrow('request cancelled')
    expect(calls).toEqual(['/app/installations?per_page=100']); expect(warn).not.toHaveBeenCalled()
  })
  it('checks cancellation after a token response and never sends a business POST with the late credential', async () => {
    const controller = new AbortController(), paths: string[] = [], beforeBusiness = vi.fn()
    const http: GitHubHttp = { request: vi.fn(async (_method, path, _body, _headers, signal) => {
      paths.push(path); expect(signal).toBe(controller.signal)
      if (path.includes('/installations?')) return { status: 200, data: [{ id: 1, account: { login: 'org' } }] as never }
      if (path.endsWith('/access_tokens')) { controller.abort(); return { status: 201, data: { token: 'test-token' } as never } }
      throw new Error('business HTTP must never start')
    }) }
    const identity = new GitHubIdentity(config(), createLogger('test', 'error'), http)
    await expect(identity.api('POST', '/repos/org/demo/pulls', {}, 'org', beforeBusiness, controller.signal)).rejects.toThrow()
    expect(paths).toEqual(['/app/installations?per_page=100', '/app/installations/1/access_tokens'])
    expect(beforeBusiness).not.toHaveBeenCalled()
  })
  it('cancels the actual axios HTTP socket during token acquisition rather than merely ignoring its later result', async () => {
    let entered!: () => void, closed!: () => void
    const hasRequest = new Promise<void>(resolve => { entered = resolve }), socketClosed = new Promise<void>(resolve => { closed = resolve })
    const server = createServer((req, res) => {
      if (req.url?.includes('/installations?')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([{ id: 1, account: { login: 'org' } }])); return }
      res.on('close', closed); entered()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const addr = server.address() as { port: number }, controller = new AbortController()
    const identity = new GitHubIdentity(config(`http://127.0.0.1:${addr.port}`), createLogger('test', 'error'))
    const pending = identity.token('org', controller.signal), rejected = expect(pending).rejects.toThrow()
    await hasRequest; controller.abort(); await rejected; await socketClosed
  })
})
