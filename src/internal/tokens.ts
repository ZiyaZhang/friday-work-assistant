/**
 * Capability token：网关按 Run 签发，MCP 工具进程凭它访问内部 API。
 * 签名绑定会话、运行和发起人；飞书 app secret 永远不离开网关进程。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface Capability {
  sessionKey: string
  /** 不可变的宿主执行编号；配置当前运行解析器的 API 拒绝缺失或旧编号。 */
  runId?: string
  chatId: string
  chatType: 'group' | 'p2p'
  /** 会话所在的空间；记忆/待办的作用域由它决定（换绑后仍指同一个空间）。老 token 没有，网关按 chat 兜底解析 */
  spaceId?: string
  requesterOpenId?: string
  /** 会话的工作区目录；下载的附件落在这里 */
  cwd?: string
  /** 明确签发的能力集合；缺少或格式错误时 token 无效。 */
  scopes: string[]
  /** 夜间整理只能修改签发时列出的候选记忆，不能改已确认条目或新增别处内容。 */
  memoryWritePolicy?: { candidateIds: number[] }
  exp: number
}

export const ALL_SCOPES = [
  'thread:read',
  'chat:read',
  'chats:list',
  /** 私聊会话专用：可读发起人也在的其他群 */
  'chat:read-others',
  'doc:read',
  'doc:write',
  'calendar:read',
  'mail:read',
  'mail:draft',
  'mcp:read',
  'mcp:call',
  /** 会议旁听：只在部署开关打开、本空间与发起人私聊都开启会议旁听时由宿主签发；巡检不签发。 */
  'meetings:read',
  'meetings:write',
  /** 需求投票：只在部署开关打开、群负责人开启本群投票时由宿主签发；巡检和私聊不签发。 */
  'polls:read',
  'polls:write',
  'file:read',
  'file:write',
  'dm:send',
  'memory:read',
  'memory:write',
  'todo:read',
  'todo:write',
  /** 发起人自己的持久查询偏好；不授予空间配置或远端仓库写权限。 */
  'profile:write',
  'pmo:write',
  'space:configure',
  'routine:read',
  'routine:write',
  'file:send',
  'skill:read',
  'skill:propose',
  'bug:read',
  'bug:record',
  'bug:write',
  'github:read',
  'github:write',
  /** 抓公开网页：URL 由模型给出，所以巡检拿不到这一项 */
  'web:read',
] as const

/** 群会话拿到的作用域：不含跨群读取，因为回答对全群可见。 */
export const GROUP_SCOPES = ALL_SCOPES.filter((s) => s !== 'chat:read-others' && s !== 'calendar:read' && !s.startsWith('mail:') && !s.startsWith('mcp:'))

/** 主动巡检只评估，不凭发现的信息登记业务状态；明确委托由新的交互运行执行。 */
export const PROACTIVE_SCOPES = [
  'thread:read',
  'chat:read',
  'chats:list',
  'doc:read',
  'file:read',
  'memory:read',
  'skill:read',
  'todo:read',
  'routine:read',
  'bug:read',
  'github:read',
] as const

export class TokenIssuer {
  constructor(private readonly secret: string) {}

  issue(cap: Omit<Capability, 'exp'>, ttlSec = 24 * 3600): string {
    const payload: Capability = { ...cap, exp: Math.floor(Date.now() / 1000) + ttlSec }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${this.sign(body)}`
  }

  verify(token: string): Capability | undefined {
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return undefined
    const body = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = this.sign(body)
    if (sig.length !== expected.length) return undefined
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined
    try {
      const cap = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Capability
      if (!cap.sessionKey || !cap.chatId || typeof cap.exp !== 'number') return undefined
      if (cap.runId !== undefined && (typeof cap.runId !== 'string' || !cap.runId.trim())) return undefined
      if (cap.exp < Math.floor(Date.now() / 1000)) return undefined
      if (!Array.isArray(cap.scopes) || !cap.scopes.every((scope) => typeof scope === 'string')) return undefined
      return cap
    } catch {
      return undefined
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}
