/**
 * 抓取准入：URL 由模型给出，而网关在内网里。
 * 这组用例守的是"别让模型把网关当成内网跳板"，不是"别抓错页面"。
 */
import { createServer, Agent as HttpAgent } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFetchable, isPrivateAddress, WebFetchRefused } from '../src/core/web-fetch.js'

const publicDns = async () => [{ address: '93.184.216.34' }]
const privateDns = async () => [{ address: '10.20.30.40' }]

async function refusal(fn: () => Promise<unknown>): Promise<WebFetchRefused> {
  try { await fn() } catch (err) { if (err instanceof WebFetchRefused) return err; throw err }
  throw new Error('应该被拒绝，但没有')
}

describe('私网判定', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1',
    '::ffff:a00:1', '0:0:0:0:0:ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', '2001::1', '3fff::1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', 'invalid'])
    ('%s 是内网/保留地址', (ip) => { expect(isPrivateAddress(ip)).toBe(true) })

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.167.1.1', '2606:4700::1111'])
    ('%s 是公网地址', (ip) => { expect(isPrivateAddress(ip)).toBe(false) })
})

describe('抓取准入', () => {
  it('公网 https 放行', async () => {
    const url = await assertFetchable('https://example.com/a?b=1', { resolve: publicDns })
    expect(url.host).toBe('example.com')
  })

  it('只认 http/https', async () => {
    expect((await refusal(() => assertFetchable('file:///etc/passwd', { resolve: publicDns }))).reason).toBe('scheme')
    expect((await refusal(() => assertFetchable('ftp://example.com/x', { resolve: publicDns }))).reason).toBe('scheme')
  })

  it('不是网址就直说', async () => {
    expect((await refusal(() => assertFetchable('随便一句话', { resolve: publicDns }))).reason).toBe('bad_url')
  })

  it('本机与内网域名一律拒绝', async () => {
    for (const u of ['http://localhost:7788/healthz', 'http://foo.internal/x', 'http://svc.cluster.local/x']) {
      expect((await refusal(() => assertFetchable(u, { resolve: publicDns }))).reason).toBe('internal_host')
    }
  })

  it('字面量内网 IP 拒绝，且根本不查 DNS', async () => {
    let asked = 0
    const resolve = async () => { asked += 1; return [{ address: '93.184.216.34' }] }
    expect((await refusal(() => assertFetchable('http://127.0.0.1:7788/healthz', { resolve }))).reason).toBe('internal_host')
    expect((await refusal(() => assertFetchable('http://169.254.169.254/latest/meta-data/', { resolve }))).reason).toBe('internal_host')
    expect(asked).toBe(0)
  })

  it('域名解析到内网也拒绝——只看主机名是挡不住的', async () => {
    const err = await refusal(() => assertFetchable('https://looks-public.example.com/x', { resolve: privateDns }))
    expect(err.reason).toBe('internal_host')
    expect(err.message).toContain('解析到内网地址')
  })

  it('多条解析结果里只要有一条是内网就拒绝', async () => {
    const mixed = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }]
    expect((await refusal(() => assertFetchable('https://mixed.example.com/', { resolve: mixed }))).reason).toBe('internal_host')
  })

  it('网址里带账号密码不抓', async () => {
    expect((await refusal(() => assertFetchable('https://user:pw@example.com/', { resolve: publicDns }))).reason).toBe('credentials')
  })

  it('解析不到就拒绝，不当成公网', async () => {
    expect((await refusal(() => assertFetchable('https://nope.example.com/', { resolve: async () => [] }))).reason).toBe('dns')
  })
})

import { fetchPublicUrl, htmlToText } from '../src/core/web-fetch.js'

const ok = (body: string, contentType = 'text/html'): { status: number; headers: Record<string, string>; body: string } =>
  ({ status: 200, headers: { 'content-type': contentType }, body })

describe('抓取', () => {
  it('抓到网页并转成可读文本', async () => {
    const page = await fetchPublicUrl('https://example.com/a', {
      resolve: publicDns,
      request: async () => ok('<html><head><title>发布说明</title><style>x{}</style></head><body><h1>0.1.6</h1><p>修了 A</p><li>修了 B</li><script>evil()</script></body></html>'),
    })
    expect(page.title).toBe('发布说明')
    expect(page.text).toContain('0.1.6')
    expect(page.text).toContain('- 修了 B')
    expect(page.text).not.toContain('evil()')
    expect(page.text).not.toContain('<')
    expect(page.hops).toEqual(['https://example.com/a'])
  })

  it('**重定向到内网地址被拦住**——第一跳是公网不代表第二跳是', async () => {
    let calls = 0
    const err = await refusal(() => fetchPublicUrl('https://example.com/start', {
      resolve: publicDns,
      request: async () => {
        calls += 1
        return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: '' }
      },
    }))
    expect(err.reason).toBe('internal_host')
    expect(calls).toBe(1) // 第二跳根本没发出去
  })

  it('域名跳到解析成内网的域名同样被拦住', async () => {
    const resolve = async (host: string) => (host === 'example.com' ? [{ address: '93.184.216.34' }] : [{ address: '10.0.0.9' }])
    const err = await refusal(() => fetchPublicUrl('https://example.com/start', {
      resolve,
      request: async () => ({ status: 301, headers: { location: 'https://inner.example.net/x' }, body: '' }),
    }))
    expect(err.reason).toBe('internal_host')
  })

  it('正常跳转会跟，并记下每一跳', async () => {
    const seen: string[] = []
    const page = await fetchPublicUrl('https://example.com/1', {
      resolve: publicDns,
      request: async (url) => {
        seen.push(url)
        return url.endsWith('/1') ? { status: 302, headers: { location: '/2' }, body: '' } : ok('<p>到了</p>')
      },
    })
    expect(seen).toEqual(['https://example.com/1', 'https://example.com/2'])
    expect(page.hops).toHaveLength(2)
    expect(page.final_url).toBe('https://example.com/2')
    expect(page.text).toBe('到了')
  })

  it('跳转太多就停，不无限跟', async () => {
    const err = await refusal(() => fetchPublicUrl('https://example.com/x', {
      resolve: publicDns, maxRedirects: 2,
      request: async () => ({ status: 302, headers: { location: 'https://example.com/y' }, body: '' }),
    }))
    expect(err.reason).toBe('too_many_redirects')
  })

  it('不是网页或文本就拒绝，不把二进制塞进上下文', async () => {
    const err = await refusal(() => fetchPublicUrl('https://example.com/a.zip', {
      resolve: publicDns, request: async () => ok('PK\u0003\u0004', 'application/zip'),
    }))
    expect(err.reason).toBe('content_type')
  })

  it('JSON 原样返回，不当 HTML 洗', async () => {
    const page = await fetchPublicUrl('https://api.example.com/x', {
      resolve: publicDns, request: async () => ok('{"tag":"0.1.6-alpha.2"}', 'application/json'),
    })
    expect(page.text).toBe('{"tag":"0.1.6-alpha.2"}')
  })

  it('htmlToText 处理实体与空行', () => {
    const { text } = htmlToText('<p>a &amp; b</p><p>&nbsp;</p><p>c</p>')
    expect(text).toBe('a & b\n\nc')
  })

  it('does not send a redirected query/code to another origin, even when its DNS would be public', async () => {
    const resolve = vi.fn(publicDns), request = vi.fn(async () => ({ status: 302, headers: { location: 'https://other.example/return?code=private' }, body: '' }))
    const err = await refusal(() => fetchPublicUrl('https://example.com/return?code=private', {
      allowedOrigin: 'https://example.com', resolve, request,
    }))
    expect(err.reason).toBe('redirect_origin'); expect(request).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce()
  })

  it('re-resolves and checks every same-origin redirect and pins exactly the checked address', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34' }]).mockResolvedValueOnce([{ address: '10.0.0.1' }])
    const request = vi.fn(async () => ({ status: 302, headers: { location: '/again' }, body: '' }))
    const err = await refusal(() => fetchPublicUrl('https://example.com/', { allowedOrigin: 'https://example.com', resolve, request }))
    expect(err.reason).toBe('internal_host'); expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]).toEqual(['https://example.com/', expect.objectContaining({ address: '93.184.216.34' })])
  })

  it('zero timeout or response budget disables the call before DNS rather than removing the limit', async () => {
    const resolve = vi.fn(publicDns), request = vi.fn(async () => ok('hello'))
    for (const options of [{ timeoutMs: 0 }, { maxBytes: 0 }]) {
      expect((await refusal(() => fetchPublicUrl('https://example.com/', { ...options, resolve, request }))).reason).toBe('disabled')
    }
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
  })

  it('stopping while DNS awaits prevents dispatch', async () => {
    const abort = new AbortController(), request = vi.fn(async () => ok('hello'))
    await expect(fetchPublicUrl('https://example.com/', { signal: abort.signal, request,
      resolve: async () => { abort.abort(); return publicDns() },
    })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('times out unresolved DNS promptly and ignores a late answer without sending HTTP', async () => {
    let finish!: (value: { address: string }[]) => void
    const pendingDns = new Promise<{ address: string }[]>(resolve => { finish = resolve })
    const request = vi.fn(async () => ok('late result')), started = Date.now()
    await expect(fetchPublicUrl('https://example.com/', { timeoutMs: 20, resolve: () => pendingDns, request })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
    finish([{ address: '93.184.216.34' }]); await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
  })
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fakeProxy(refuse = false, stall = false) {
  const server = createServer(), sockets = new Set<Socket>(), targets: string[] = [], requests: string[] = []
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('connect', (req, socket) => {
    targets.push(req.url!)
    if (stall) return
    if (refuse) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let data = ''
    socket.on('data', chunk => {
      data += chunk.toString()
      if (!data.includes('\r\n\r\n')) return
      requests.push(data)
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, targets, requests }
}

describe('Actual Node HTTP transport address pinning', () => {
  it('applies the finite timeout while waiting for a proxy CONNECT response', async () => {
    const proxy = await fakeProxy(false, true), start = Date.now()
    await expect(fetchPublicUrl('https://example.com/', { resolve: publicDns, proxyUrl: proxy.url, timeoutMs: 30 })).rejects.toThrow()
    expect(proxy.targets).toEqual(['93.184.216.34:443'])
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('aborts an in-flight CONNECT when the owning Run stops', async () => {
    const proxy = await fakeProxy(false, true), stop = new AbortController()
    const pending = fetchPublicUrl('https://example.com/', { resolve: publicDns, proxyUrl: proxy.url, signal: stop.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(proxy.targets).toHaveLength(1))
    stop.abort(); await rejected
    expect(proxy.requests).toEqual([])
  })

  it('asks the proxy to CONNECT only to the checked numeric IP, preserving the original HTTP Host', async () => {
    const proxy = await fakeProxy(), resolve = vi.fn(publicDns)
    const page = await fetchPublicUrl('http://example.com/page?q=one', { resolve, proxyUrl: proxy.url })
    expect(page.text).toBe('hello'); expect(resolve).toHaveBeenCalledOnce()
    expect(proxy.targets).toEqual(['93.184.216.34:80'])
    expect(proxy.requests[0]).toContain('GET /page?q=one HTTP/1.1')
    expect(proxy.requests[0]).toMatch(/host: example\.com\r\n/i)
  })

  it('does not fall back to hostname CONNECT when a proxy refuses numeric targets', async () => {
    const proxy = await fakeProxy(true)
    const err = await refusal(() => fetchPublicUrl('http://example.com/', { resolve: publicDns, proxyUrl: proxy.url }))
    expect(err.reason).toBe('http_status'); expect(proxy.targets).toEqual(['93.184.216.34:80']); expect(proxy.requests).toEqual([])
  })

  it('pins direct lookup and ignores ambient proxy settings while preserving HTTP Host', async () => {
    const seen: string[] = [], lookups: unknown[] = []
    const server = createServer((req, res) => { seen.push(req.headers.host!); res.end('hello') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const port = (server.address() as AddressInfo).port
    // Only the test socket is redirected to our local fixture. All production
    // request construction, Agent lookup selection and HTTP handling remain real.
    vi.spyOn(HttpAgent.prototype, 'createConnection').mockImplementation((options: any) => {
      expect(options.host).toBe('example.com')
      options.lookup('example.com', { all: true }, (error: unknown, addresses: unknown) => { expect(error).toBeNull(); lookups.push(addresses) })
      return connect({ host: '127.0.0.1', port })
    })
    vi.stubEnv('HTTP_PROXY', 'http://ambient-proxy.invalid:1'); vi.stubEnv('NO_PROXY', '')
    const resolve = vi.fn(publicDns)
    const page = await fetchPublicUrl('http://example.com/', { resolve })
    expect(page.text).toBe('hello'); expect(seen).toEqual(['example.com']); expect(resolve).toHaveBeenCalledOnce()
    expect(lookups).toEqual([[{ address: '93.184.216.34', family: 4 }]])
  })

  it('keeps HTTPS certificate verification bound to the original hostname when CONNECT uses an IP', async () => {
    let inspected = false
    vi.spyOn(HttpsProxyAgent.prototype, 'connect').mockImplementation(async (_req, options) => {
      expect(options.host).toBe('93.184.216.34')
      if (!options.secureEndpoint) throw new Error('expected TLS')
      expect(options.servername).toBe('example.com')
      expect(options.rejectUnauthorized).toBe(true)
      expect(options.checkServerIdentity!('93.184.216.34', { subjectaltname: 'DNS:attacker.example' } as never)).toBeInstanceOf(Error)
      expect(options.checkServerIdentity!('93.184.216.34', { subjectaltname: 'DNS:example.com' } as never)).toBeUndefined()
      inspected = true
      throw new Error('synthetic transport end')
    })
    await expect(fetchPublicUrl('https://example.com/', { resolve: publicDns, proxyUrl: 'http://127.0.0.1:1' })).rejects.toThrow('synthetic transport end')
    expect(inspected).toBe(true)
  })
})
