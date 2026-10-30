/**
 * 抓取公开网页：让"用户贴了个链接"这件事真的能被读进来。
 *
 * 这条路径的 URL 由模型给出，而网关可能跑在内网里——代码仓库、模型服务、云元数据、
 * 网关自己的 127.0.0.1:7788 都在同一张网上。所以准入不是"看着像个网址就抓"，
 * 而是：协议白名单 + 主机名黑名单 + **解析后的 IP 必须是公网**，且每一次重定向都要重新过一遍。
 *
 * 只按主机名判断是不够的：`evil.example.com` 可以解析到 10.0.0.1，
 * 所以必须查真实解析结果，而不是字符串。
 */
import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

export class WebFetchRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
  }
}

/** 明确不许碰的主机名（内网服务与本机）。解析后的 IP 另外还要过私网检查。 */
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal'])
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localdomain', '.cluster.local']

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = p as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // 云厂商元数据
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return true
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true // 组播与保留段
  return false
}

function isPrivateV6(ip: string): boolean {
  // Only globally routable unicast. This also rejects IPv4-mapped, NAT64,
  // transition and scoped addresses instead of guessing their eventual target.
  if (isIP(ip) !== 6 || ip.includes('%')) return true
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const [first, second] = normalized.split(':').map(part => parseInt(part || '0', 16))
  if (first! < 0x2000 || first! > 0x3fff) return true
  if (first === 0x2001 && (second! <= 0x1ff || second === 0xdb8)) return true
  return first === 0x2002 || first === 0x3ffe || first === 0x3fff
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateV6(ip) : isPrivateV4(ip)
}

export interface FetchGuardOptions {
  /** 注入用：默认走系统 DNS，测试里给确定的解析结果 */
  resolve?: (host: string) => Promise<{ address: string }[]>
  /** Host-issued restriction: no query/path may be redirected to another origin. */
  allowedOrigin?: string
  assertCurrent?: () => void
  signal?: AbortSignal
}

/**
 * 判断一个 URL 能不能抓。不能抓就抛 WebFetchRefused，理由是可以直接讲给人听的那种。
 * 每次重定向都要再调一次——第一跳是公网不代表第二跳是。
 */
export async function assertFetchable(raw: string, opts: FetchGuardOptions = {}): Promise<URL> {
  return (await resolveFetchable(raw, opts)).url
}

function checkCurrent(opts: FetchGuardOptions): void {
  opts.signal?.throwIfAborted()
  opts.assertCurrent?.()
}

/** DNS promises do not accept an AbortSignal. Stop awaiting them promptly and
 * consume their late resolution/rejection without ever dispatching a request. */
function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) })
    if (signal.aborted) aborted()
  })
}

async function resolveFetchable(raw: string, opts: FetchGuardOptions): Promise<{ url: URL; address: string }> {
  checkCurrent(opts)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebFetchRefused('bad_url', '这不是一个完整的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchRefused('scheme', `只支持 http 和 https，这个是 ${url.protocol.replace(':', '')}`)
  }
  if (url.username || url.password) {
    throw new WebFetchRefused('credentials', '网址里带账号密码，不抓')
  }
  url.hash = ''
  if (opts.allowedOrigin && url.origin !== opts.allowedOrigin) {
    throw new WebFetchRefused('redirect_origin', '这个链接跳转到了另一个网站。请提供目标网站的完整链接再读取')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) throw new WebFetchRefused('bad_url', '网址里没有主机名')
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new WebFetchRefused('internal_host', `${host} 是内网地址，不抓`)
  }
  // 字面量 IP 直接判；域名要看真实解析结果，否则一个指向 10.x 的域名就绕过去了
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  const addresses = literal ? [{ address: host }] : await withAbort((opts.resolve ?? ((h: string) => lookup(h, { all: true })))(host), opts.signal)
  checkCurrent(opts)
  if (!addresses.length) throw new WebFetchRefused('dns', `解析不到 ${host}`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new WebFetchRefused('internal_host', `${host} 解析到内网地址，不抓`)
  }
  return { url, address: addresses[0]!.address }
}

export interface FetchedPage {
  url: string
  final_url: string
  status: number
  content_type: string
  title?: string
  text: string
  bytes: number
  truncated: boolean
  /** 实际跳了哪几跳；每一跳都单独过了准入 */
  hops: string[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }

/** HTML → 可读文本：去掉脚本样式，保留段落边界。不做渲染，只求人能看懂。 */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#x?[0-9a-f]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim()
  return { title: title ? title.replace(/\s+/g, ' ') : undefined, text }
}

export interface RawResponse { status: number; headers: Record<string, string | undefined>; body: string }

export interface FetchPublicOptions extends FetchGuardOptions {
  proxyUrl?: string
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  /** 注入用：测试里不真的出网 */
  request?: (url: string, opts: PinnedRequestOptions) => Promise<RawResponse>
}

interface PinnedRequestOptions {
  address: string
  proxyUrl?: string
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
  assertCurrent?: () => void
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}

/** A single authenticated request to a configured public HTTPS endpoint.
 * Unlike page navigation, credentials and bodies never follow redirects. */
export async function requestPublicEndpoint(raw: string, input: { method: 'POST' | 'DELETE'; headers: Record<string, string>; body?: string }, opts: FetchPublicOptions = {}): Promise<RawResponse> {
  if (input.body && Buffer.byteLength(input.body) > 128_000) throw new WebFetchRefused('bad_limit', '请求内容过长。')
  const timeoutMs = opts.timeoutMs ?? 20_000, maxBytes = opts.maxBytes ?? 512_000
  const guarded = { ...opts, signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(timeoutMs)]) }
  const { url, address } = await resolveFetchable(raw, guarded)
  if (url.protocol !== 'https:') throw new WebFetchRefused('bad_protocol', '连接需要 HTTPS。')
  checkCurrent(guarded)
  const value = await (opts.request ?? defaultRequest)(url.toString(), { address, proxyUrl: opts.proxyUrl, timeoutMs, maxBytes,
    signal: guarded.signal, assertCurrent: opts.assertCurrent, ...input })
  checkCurrent(guarded)
  if (value.status >= 300 && value.status < 400) throw new WebFetchRefused('redirect', '连接地址发生跳转，请填写最终的 MCP 地址。')
  return value
}

/**
 * 抓一个公开网页。重定向自己跟，**每一跳都重新过准入**——
 * 第一跳是公网不代表第二跳不是 169.254.169.254。
 */
export async function fetchPublicUrl(raw: string, opts: FetchPublicOptions = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? 512 * 1024
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxRedirects = opts.maxRedirects ?? 5
  const request = opts.request ?? defaultRequest
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WebFetchRefused('disabled', '本次网页读取已停用')
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new WebFetchRefused('bad_limit', '网页跳转次数配置无效')
  opts = { ...opts, signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(timeoutMs)]) }
  const hops: string[] = []
  let current = raw
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url, address } = await resolveFetchable(current, opts)
    checkCurrent(opts)
    hops.push(url.toString())
    const res = await request(url.toString(), { address, proxyUrl: opts.proxyUrl, timeoutMs, maxBytes, signal: opts.signal, assertCurrent: opts.assertCurrent })
    checkCurrent(opts)
    const location = res.headers['location']
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === maxRedirects) throw new WebFetchRefused('too_many_redirects', `跳转超过 ${maxRedirects} 次，停了`)
      current = new URL(location, url).toString()
      continue
    }
    // A proxy's CONNECT refusal must never masquerade as public destination
    // content or enter the source ledger with a public receipt.
    if (res.status < 200 || res.status >= 300) throw new WebFetchRefused('http_status', `目标返回 HTTP ${res.status}，未读取页面内容`)
    const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (contentType && !/^text\/|json|xml|javascript$/.test(contentType)) {
      throw new WebFetchRefused('content_type', `这是 ${contentType}，不是网页或文本；下载文件请给具体需求`)
    }
    const body = res.body ?? ''
    const truncated = Buffer.byteLength(body, 'utf8') >= maxBytes
    const parsed = /html/.test(contentType) ? htmlToText(body) : { title: undefined, text: body }
    return {
      url: raw, final_url: url.toString(), status: res.status, content_type: contentType || 'unknown',
      title: parsed.title, text: parsed.text, bytes: Buffer.byteLength(body, 'utf8'), truncated, hops,
    }
  }
  throw new WebFetchRefused('too_many_redirects', `跳转超过 ${maxRedirects} 次，停了`)
}

/** CONNECT uses the verified numeric address. The proxy never resolves the target;
 * the original hostname remains the HTTP Host and TLS verification/SNI identity. */
class PinnedProxyAgent extends HttpsProxyAgent<string> {
  constructor(proxy: string, private readonly target: URL, private readonly pinned: PinnedRequestOptions) { super(proxy, { signal: pinned.signal, rejectUnauthorized: true }) }
  override async connect(req: ClientRequest, opts: Parameters<HttpsProxyAgent<string>['connect']>[1]) {
    checkCurrent(this.pinned)
    const hostname = this.target.hostname.replace(/^\[|\]$/g, '')
    const socket = await super.connect(req, opts.secureEndpoint ? { ...opts, host: this.pinned.address,
      rejectUnauthorized: true,
      servername: isIP(hostname) ? undefined : hostname,
      checkServerIdentity: (_host, cert) => checkServerIdentity(hostname, cert),
    } : { ...opts, host: this.pinned.address })
    try { checkCurrent(this.pinned); return socket } catch (error) { socket.destroy(); throw error }
  }
}

async function defaultRequest(url: string, o: PinnedRequestOptions): Promise<RawResponse> {
  checkCurrent(o)
  const target = new URL(url)
  // Never consult DNS again after preflight, including Node's all-address lookup.
  const pinnedLookup: NonNullable<ConstructorParameters<typeof HttpAgent>[0]>['lookup'] = (_host, options, callback) => {
    try { checkCurrent(o) } catch (error) { callback(error as Error, '', 0); return }
    const family = isIP(o.address)
    if (typeof options === 'object' && options.all) callback(null, [{ address: o.address, family }])
    else callback(null, o.address, family)
  }
  const agent = o.proxyUrl ? new PinnedProxyAgent(o.proxyUrl, target, o) :
    target.protocol === 'https:' ? new HttpsAgent({ lookup: pinnedLookup, rejectUnauthorized: true }) : new HttpAgent({ lookup: pinnedLookup })
  try {
    const res = await axios.request<string>({ url, method: o.method ?? 'GET', data: o.body,
      timeout: o.timeoutMs, responseType: 'text', maxRedirects: 0, maxContentLength: o.maxBytes,
      validateStatus: () => true, decompress: true, signal: o.signal,
      httpAgent: agent, httpsAgent: agent, proxy: false,
      headers: { 'User-Agent': 'friday', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', ...o.headers },
    })
    checkCurrent(o)
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : (v as string | undefined)
    return { status: res.status, headers, body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) }
  } finally { agent.destroy() }
}
