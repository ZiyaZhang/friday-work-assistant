/**
 * 出网代理：部分容器只能经 HTTP 代理访问 open.feishu.cn，
 * 而 dsh 等又不能吃全局代理，所以代理只挂在 Friday 自己的飞书 HTTP 客户端和长连接上。
 *
 * 飞书 SDK 的 Client / WSClient 都接受 httpInstance（axios 实例）与 agent（WebSocket 用），
 * 这里照 SDK 默认实例的两个拦截器（UA、返回 data）重建一个带代理的实例。
 */
import axios from 'axios'
import type { HttpInstance } from '@larksuiteoapi/node-sdk'
import { HttpsProxyAgent } from 'https-proxy-agent'

export interface ProxiedHttp {
  proxyUrl: string
  /** 给 WSClient 的 agent 参数（ws 库用它建立 CONNECT 隧道） */
  agent: HttpsProxyAgent<string>
  /** 给 Client / WSClient 的 httpInstance 参数（拦截器已把返回值拆成 data，和 SDK 默认实例一致） */
  httpInstance: HttpInstance
}

/** 从环境变量里解析飞书专用代理：FRIDAY_FEISHU_PROXY 优先，其次 HTTPS_PROXY / https_proxy。 */
export function resolveFeishuProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.FRIDAY_FEISHU_PROXY?.trim()
  if (explicit === 'off' || explicit === 'none' || explicit === '0') return undefined
  if (explicit) return explicit
  return env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || undefined
}

export function createProxiedHttp(proxyUrl: string, userAgent = 'friday'): ProxiedHttp {
  const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true })
  const httpInstance = axios.create({ httpsAgent: agent, httpAgent: agent, proxy: false })
  httpInstance.interceptors.request.use(
    (req) => {
      if (req.headers && !req.headers['User-Agent']) req.headers['User-Agent'] = userAgent
      return req
    },
    undefined,
    { synchronous: true },
  )
  httpInstance.interceptors.response.use((resp) => {
    const cfg = resp.config as { $return_headers?: boolean }
    if (cfg.$return_headers) return { data: resp.data, headers: resp.headers } as unknown as typeof resp
    return resp.data
  })
  return { proxyUrl, agent, httpInstance: httpInstance as unknown as HttpInstance }
}

/** 日志里只显示 host:port，不带账号密码。 */
export function describeProxy(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.username ? '（带认证）' : ''}`
  } catch {
    return '(invalid proxy url)'
  }
}
