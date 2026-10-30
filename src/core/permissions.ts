/**
 * 工具调用的"人话摘要"与权限归类。
 *
 * dsh 的 ACP 桥把每个工具都报成 kind=other、title=工具名（bash / write / edit / feishu_*…），
 * 而 session/request_permission 只带 toolCallId（没有 title、kind、rawInput）。
 * 所以 Friday 要自己记住每个 tool_call 的 rawInput，收到权限请求时按 id 找回来，
 * 再按工具名判断这是"跑命令"还是"改文件"，把命令 / 路径 / 模型的理由写进确认卡片。
 *
 * dsh 只在两种情况下发权限请求：bash 的沙箱升级（sandbox_permissions + justification）
 * 和 write/edit 越出工作区（同样两个字段）。没有可用的沙箱后端时，
 * 每条 bash 命令都会先被拒、再以 danger-full-access 重试——那次重试就是我们收到的请求。
 */
import type { ToolKind } from '@agentclientprotocol/sdk'

export type ToolCategory = 'execute' | 'edit' | 'read' | 'other'

export interface ToolSummary {
  category: ToolCategory
  /** 一行摘要：命令本身 / 文件路径 / 关键参数 */
  detail?: string
  /** 模型给的一句话说明（bash 工具的 description 参数） */
  description?: string
  /** 沙箱升级请求：目标模式与模型的理由 */
  escalation?: { mode: string; justification?: string }
}

const EXECUTE_TITLES = /^(bash|sh|zsh|shell|pwsh|powershell|terminal|cmd|command|exec|execute|run(?:_[a-z]+)?|python\d*|node|script|job_[a-z]+)$/i
const EDIT_TITLES = /^(write|edit|multi_?edit|str_replace(?:_[a-z]+)?|create(?:_[a-z]+)?|delete|remove|rm|move|mv|rename|mkdir|touch|patch|apply(?:_[a-z]+)?|append|insert|save(?:_[a-z]+)?)$/i
const READ_TITLES = /^(read(?:_[a-z]+)?|cat|ls|list(?:_[a-z]+)?|glob|grep|search|find|fetch|view|head|tail|stat)$/i

/** 先看工具名（dsh 报的 kind 一律是 other，没有信息量），再退到 ACP kind。 */
export function categorizeTool(title: string | undefined, kind?: ToolKind | null): ToolCategory {
  const t = (title ?? '').trim()
  if (EXECUTE_TITLES.test(t)) return 'execute'
  if (EDIT_TITLES.test(t)) return 'edit'
  if (READ_TITLES.test(t)) return 'read'
  switch (kind) {
    case 'execute':
      return 'execute'
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
      return 'read'
    default:
      return 'other'
  }
}

const DETAIL_KEYS = ['command', 'cmd', 'script', 'code', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'name', 'title']

/** 从 rawInput 里挑最能说明"要干什么"的一个字段（保留换行，卡片行内显示时再压成一行）。 */
export function describeRawInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return trimLong(raw)
  if (Array.isArray(raw)) return trimLong(raw.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  if (typeof raw !== 'object') return trimLong(String(raw))
  const obj = raw as Record<string, unknown>
  for (const k of DETAIL_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return trimLong(v)
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return trimLong((v as string[]).join(' '))
  }
  try {
    const s = JSON.stringify(obj)
    return s && s !== '{}' ? trimLong(s) : undefined
  } catch {
    return undefined
  }
}

export function summarizeTool(input: { title?: string | null; kind?: ToolKind | null; rawInput?: unknown }): ToolSummary {
  const category = categorizeTool(input.title ?? undefined, input.kind)
  const out: ToolSummary = { category }
  const detail = describeRawInput(input.rawInput)
  if (detail) out.detail = detail
  if (input.rawInput && typeof input.rawInput === 'object' && !Array.isArray(input.rawInput)) {
    const obj = input.rawInput as Record<string, unknown>
    if (typeof obj.description === 'string' && obj.description.trim()) out.description = oneLine(obj.description)
    if (typeof obj.sandbox_permissions === 'string' && obj.sandbox_permissions.trim()) {
      out.escalation = { mode: obj.sandbox_permissions.trim(), ...(typeof obj.justification === 'string' && obj.justification.trim() ? { justification: oneLine(obj.justification) } : {}) }
    }
  }
  return out
}

function oneLine(s: string): string {
  return trimLong(s.replace(/\s+/g, ' '))
}

function trimLong(s: string): string {
  const t = s.trim()
  return t.length > 2000 ? t.slice(0, 1999) + '…' : t
}
