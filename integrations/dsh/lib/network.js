import { execFileSync } from 'node:child_process'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** Use the same proxy already configured for the desktop. Do not change system
 * settings, disable TLS verification, or send device credentials to a redirect. */
export function configuredProxy({ env = process.env, platform = process.platform, system = () => execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 }) } = {}) {
  const configured = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
  if (configured) {
    const url = new URL(configured)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Friday 需要 HTTP 或 HTTPS 代理。')
    return url.href
  }
  if (platform !== 'darwin') return undefined
  let value
  try { value = system() } catch { return undefined }
  const field = name => value.match(new RegExp('^\\s*' + name + '\\s*:\\s*(\\S+)\\s*$', 'm'))?.[1]
  if (field('HTTPSEnable') !== '1') return undefined
  const host = field('HTTPSProxy'), port = Number(field('HTTPSPort'))
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${port}/`
}

export function createDesktopFetch({ direct = globalThis.fetch, proxy = configuredProxy, request = https.request } = {}) {
  let cachedAt = 0, agent, address
  return async (url, init = {}) => {
    if (Date.now() - cachedAt > 60_000) {
      const next = proxy()
      if (next !== address) { agent?.destroy(); address = next; agent = next ? new HttpsProxyAgent(next, { keepAlive: true }) : undefined }
      cachedAt = Date.now()
    }
    if (!agent) return direct(url, init)
    if (new URL(url).protocol !== 'https:') throw new Error('Friday 连接需要 HTTPS。')
    return new Promise((resolve, reject) => {
      const req = request(url, { method: init.method ?? 'GET', agent, signal: init.signal,
        headers: { ...Object.fromEntries(new Headers(init.headers)), 'accept-encoding': 'identity' } }, res => {
        const chunks = []; let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > 650_000) res.destroy(new Error('Friday 返回的内容过长。')); else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(
          Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])) })))
      })
      req.on('error', reject)
      req.end(init.body)
    })
  }
}
