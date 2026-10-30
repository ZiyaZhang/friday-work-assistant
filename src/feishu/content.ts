/**
 * 飞书消息 content 字段是 JSON 字符串，形状随 msg_type 变化。
 * 这里统一转成给模型看的纯文本，图片/文件只留元信息。
 */

export interface MentionInfo {
  key: string
  openId?: string
  name: string
}

interface PostNode {
  tag?: string
  text?: string
  href?: string
  user_name?: string
  user_id?: string
  image_key?: string
  file_key?: string
  [k: string]: unknown
}

export function parseContent(msgType: string, content: string, mentions: MentionInfo[] = []): string {
  let obj: unknown
  try {
    obj = JSON.parse(content)
  } catch {
    if (msgType === 'interactive') return '[卡片]\n[卡片正文未取得：返回内容不是可解析的 JSON；不能据此判断没有回复]'
    return content
  }
  const o = (obj ?? {}) as Record<string, unknown>
  switch (msgType) {
    case 'text':
      return replaceMentionKeys(String(o.text ?? ''), mentions)
    case 'post':
      return replaceMentionKeys(postToText(o), mentions)
    case 'image':
      return `[图片 ${String(o.image_key ?? '')}]`
    case 'file':
      return `[文件 ${String(o.file_name ?? o.file_key ?? '')}]`
    case 'audio':
      return `[语音]`
    case 'media':
      return `[视频 ${String(o.file_name ?? '')}]`
    case 'sticker':
      return `[表情]`
    case 'share_chat':
      return `[分享群 ${String(o.chat_id ?? '')}]`
    case 'share_user':
      return `[分享用户 ${String(o.user_id ?? '')}]`
    case 'merge_forward':
      return `[合并转发消息]`
    case 'interactive':
      return cardToText(o)
    case 'system':
      return `[系统消息]`
    default:
      return `[${msgType}] ${content.slice(0, 500)}`
  }
}

/** 把 `@_user_1` 这类占位符换成 `@名字`；未知占位符保留原样。 */
export function replaceMentionKeys(text: string, mentions: MentionInfo[]): string {
  if (!mentions.length) return text
  let out = text
  for (const m of mentions) {
    if (!m.key) continue
    out = out.split(m.key).join(`@${m.name}`)
  }
  return out
}

function postToText(o: Record<string, unknown>): string {
  // 两种形状：{title, content:[[...]]} 或 {zh_cn:{title, content}, en_us:{...}}
  let post = o
  if (!Array.isArray(o.content)) {
    const first = Object.values(o).find((v) => v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).content))
    if (first) post = first as Record<string, unknown>
  }
  const lines: string[] = []
  const title = typeof post.title === 'string' && post.title.trim() ? post.title.trim() : ''
  if (title) lines.push(title)
  const content = Array.isArray(post.content) ? (post.content as PostNode[][]) : []
  for (const para of content) {
    if (!Array.isArray(para)) continue
    const parts: string[] = []
    for (const node of para) {
      if (!node || typeof node !== 'object') continue
      switch (node.tag) {
        case 'text':
          parts.push(String(node.text ?? ''))
          break
        case 'a':
          parts.push(node.href ? `${String(node.text ?? '')}(${String(node.href)})` : String(node.text ?? ''))
          break
        case 'at':
          parts.push(`@${String(node.user_name ?? node.user_id ?? '')}`)
          break
        case 'img':
          parts.push(`[图片 ${String(node.image_key ?? '')}]`)
          break
        case 'media':
          parts.push(`[视频 ${String(node.file_key ?? '')}]`)
          break
        case 'emotion':
          parts.push(`[${String((node as { emoji_type?: string }).emoji_type ?? '表情')}]`)
          break
        case 'code_block':
          parts.push('\n```\n' + String(node.text ?? '') + '\n```\n')
          break
        case 'hr':
          parts.push('\n---\n')
          break
        default:
          if (typeof node.text === 'string') parts.push(node.text)
      }
    }
    lines.push(parts.join(''))
  }
  return lines.join('\n').trim()
}

function cardToText(o: Record<string, unknown>): string {
  const texts: string[] = []
  let bodyText = false
  const add = (s: string, title: boolean): void => {
    if (!s.trim()) return
    texts.push(s)
    if (!title) bodyText = true
  }
  // 只走显示结构，不把按钮 value / URL 参数 / 模板变量等非正文当成已读内容。
  const visibleKeys = new Set(['header', 'title', 'body', 'elements', 'columns', 'fields', 'text', 'content', 'extra', 'subtitle', 'summary', 'i18n_elements', 'i18n_header'])
  const textTags = new Set(['markdown', 'plain_text', 'lark_md', 'div', 'text', 'a'])
  const walk = (v: unknown, title = false): void => {
    if (!v) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, title)
      return
    }
    if (typeof v === 'object') {
      const r = v as Record<string, unknown>
      const tag = typeof r.tag === 'string' ? r.tag : ''
      if (textTags.has(tag) && typeof r.content === 'string') add(r.content, title)
      else if (textTags.has(tag) && typeof r.text === 'string') add(r.text, title)
      for (const [k, x] of Object.entries(r)) {
        if (!visibleKeys.has(k)) continue
        if (typeof x === 'string') {
          // message.get 的卡片摘要还可能用 title 字符串和没有 tag 的 text 对象。
          if (k === 'title' || k === 'subtitle') add(x, true)
          else if (!tag && k === 'text') add(x, title)
          continue
        }
        if ((k === 'i18n_elements' || k === 'i18n_header') && x && typeof x === 'object' && !Array.isArray(x)) {
          const languages = x as Record<string, unknown>
          walk(languages.zh_cn ?? languages.en_us ?? Object.values(languages)[0], title || k === 'i18n_header')
        } else walk(x, title || k === 'header' || k === 'title' || k === 'subtitle')
      }
    }
  }
  walk(o)
  const joined = texts.join('\n').trim()
  const missing = bodyText ? '' : '\n[卡片正文未取得：当前返回结构没有可提取正文；不能据此判断没有回复]'
  return `[卡片]${joined ? `\n${joined}` : ''}${missing}`
}

/** 从 Feishu 事件里的 mentions 数组归一化。 */
export function normalizeMentions(raw: unknown): MentionInfo[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((m) => {
      const r = (m ?? {}) as Record<string, unknown>
      const id = (r.id ?? {}) as Record<string, unknown>
      return { key: String(r.key ?? ''), openId: typeof id.open_id === 'string' ? id.open_id : undefined, name: String(r.name ?? '') }
    })
    .filter((m) => m.key || m.name)
}
