/**
 * 普通回复走飞书"富文本"消息（post 的 md 标签）：看起来就是一条普通消息，
 * 但支持加粗 / 列表 / 行内代码 / 代码块 / 链接 / 引用。
 * md 标签不支持标题、表格和 HTML，这里在发送前转换；结果不确定时不自动补发。
 */

/** 单条富文本消息的正文上限（字符）；超过就切成多条 */
export const POST_CHUNK = 3500

/** 模型输出的 Markdown → post md 标签能显示的子集。 */
export function markdownForPost(md: string): string {
  let s = md.replace(/\r\n/g, '\n')
  // 卡片语法里的 <font color="...">x</font> → x
  s = s.replace(/<\/?font[^>]*>/g, '')
  const lines = s.split('\n')
  const out: string[] = []
  let inFence = false
  for (const raw of lines) {
    let line = raw
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    // 标题 → 粗体行
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      out.push(`**${heading[1]?.trim()}**`)
      continue
    }
    // 表格：分隔行删掉，其他行去掉首尾竖线、单元格用 · 拼
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line.replace(/\|/g, ' '))) continue
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      out.push(cells.join(' · '))
      continue
    }
    // 只有 * 号的分割线
    if (/^\s*(\*\s*){3,}$/.test(line)) {
      out.push('---')
      continue
    }
    out.push(line)
  }
  // 连续三个以上空行压成两个
  // 只去外围空行，保留首行缩进；它可能表示代码，不能因此把字面 @ 变成通知。
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
}

/** 纯文本兜底：把 Markdown 标记去掉，保留内容。 */
export function stripMarkdown(md: string): string {
  const lines = markdownForPost(md).split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    let t = line
    t = t.replace(/^\s*[-*+]\s+/, '• ')
    t = t.replace(/^\s*>\s?/, '')
    t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    t = t.replace(/~~(.+?)~~/g, '$1')
    t = t.replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1$2')
    t = t.replace(/`([^`]+)`/g, '$1')
    t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text}（${url}）`))
    if (t === '---') continue
    out.push(t)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 按行切成多段，尽量不在代码块中间切；切开时补上 ``` 让每段都闭合。 */
export function chunkMarkdown(md: string, size = POST_CHUNK): string[] {
  // 切片会丢失围栏/引用/行内代码的起点，先在完整原文中把字面标签消歧。
  md = protectPostMentionLiterals(md)
  if (md.length <= size) return md ? [md] : []
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  let inFence = false
  let fenceHeader = ''
  const flush = (): void => {
    if (!cur.length) return
    let text = cur.join('\n')
    if (inFence) text += '\n```'
    chunks.push(text)
    cur = inFence ? [fenceHeader || '```'] : []
    curLen = cur.reduce((n, l) => n + l.length + 1, 0)
  }
  for (const line of md.split('\n')) {
    // 单行就超长：硬切
    if (line.length > size) {
      flush()
      for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size))
      cur = []
      curLen = 0
      continue
    }
    if (curLen + line.length + 1 > size) flush()
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      fenceHeader = inFence ? line : ''
    }
    cur.push(line)
    curLen += line.length + 1
  }
  if (cur.length && !(cur.length === 1 && inFence && cur[0] === fenceHeader)) chunks.push(cur.join('\n'))
  return chunks.filter((c) => c.trim())
}

/** 仅用于决定是否准备成员名单；这不是身份或通知授权。 */
export function hasPostMentions(markdown: string): boolean {
  return /<at\b/i.test(markdown)
}

type PostElement = { tag: 'md'; text: string } | { tag: 'at'; user_id: string }
const INLINE_QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' }

/**
 * 原生 at 只接收宿主核实的目标会话成员；缺名单时不通知。
 * open_id 标签是 Friday whois 的输出格式，飞书 post 使用 user_id 字段：
 * https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md
 */
function mentionElements(markdown: string, renderMention: (openId: string, name: string, marker: string) => PostElement): PostElement[] {
  const elements: PostElement[] = []
  let pending = ''
  const flush = (): void => {
    if (!pending) return
    // 原始 user_id / all 等标签也不能借 md 的内联语法绕过名单。
    // 零宽字符只打断标签语法，代码与引用仍保留可读的字面形式。
    elements.push({ tag: 'md', text: pending.replace(/<(?=\/?at\b)/gi, '<\u200b') })
    pending = ''
  }
  let fence: { char: string; length: number } | undefined
  let inlineTicks: string | undefined
  const quoteStack: string[] = []
  let quotedParagraph = false
  for (const [index, line] of markdown.split('\n').entries()) {
    if (index) pending += '\n'
    let i = 0
    if (inlineTicks) {
      const close = new RegExp('(?<!`)' + inlineTicks + '(?!`)').exec(line)
      if (!close) { pending += line; continue }
      i = close.index + inlineTicks.length
      pending += line.slice(0, i)
      inlineTicks = undefined
    }
    const marker = i === 0 && !quoteStack.length ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) : null
    if (fence) {
      pending += line
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      continue
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length }
      pending += line
      continue
    }
    if (!line.trim()) quotedParagraph = false
    if (!quoteStack.length && /^\s*>/.test(line)) quotedParagraph = true
    if (i === 0 && !quoteStack.length && (quotedParagraph || /^(?: {4}|\t)/.test(line))) { pending += line; continue }
    for (; i < line.length;) {
      const rest = line.slice(i)
      // 代码、转义、行内引用和 Markdown 链接中的标签都是原文，不是通知意图。
      const endQuote = INLINE_QUOTES[line[i]!]
      const pairedQuote = endQuote && line[i] !== '"' && line[i] !== "'"
      if (quoteStack.length || pairedQuote) {
        if (pairedQuote) quoteStack.push(endQuote)
        else if (line[i] === quoteStack.at(-1)) quoteStack.pop()
        pending += line[i++]
        continue
      }
      if (line[i] === '\\') { pending += line.slice(i, i + 2); i += 2; continue }
      if (line[i] === '`') {
        const ticks = /^`+/.exec(rest)![0]
        const close = new RegExp('(?<!`)' + ticks + '(?!`)').exec(line.slice(i + ticks.length))
        const end = close ? i + ticks.length + close.index + ticks.length : line.length
        if (!close) inlineTicks = ticks
        pending += line.slice(i, end); i = end; continue
      }
      if (endQuote) {
        const end = line.indexOf(endQuote, i + 1)
        if (end !== -1) { pending += line.slice(i, end + 1); i = end + 1; continue }
      }
      const link = /^!?\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/.exec(rest)
      if (link) { pending += link[0]; i += link[0].length; continue }
      const mention = /^<at\s+open_id="(ou_[A-Za-z0-9_-]{1,128})">([^<>\r\n]*)<\/at>/.exec(rest)
      if (mention) {
        flush()
        elements.push(renderMention(mention[1]!, mention[2]!.trim(), mention[0]))
        i += mention[0].length
        continue
      }
      pending += line[i++]
    }
  }
  flush()
  if (!elements.length) elements.push({ tag: 'md', text: '' })
  // 合并相邻 Markdown 段，保留一个完整的格式上下文。
  return elements.reduce<PostElement[]>((out, element) => {
    const previous = out.at(-1)
    if (previous?.tag === 'md' && element.tag === 'md') previous.text += element.text
    else out.push(element)
    return out
  }, [])
}

/** 切片前只屏蔽字面标签；真正的通知候选仍须在发送时核验成员名单。 */
export function protectPostMentionLiterals(markdown: string): string {
  return mentionElements(markdown, (_id, _name, marker) => ({ tag: 'md', text: marker }))
    .map((element) => element.tag === 'md' ? element.text : '').join('')
}

/** post 普通 Markdown 与已核实的原生 at 节点；不接受正文自报通知授权。 */
export function postContent(markdown: string, title?: string, allowedMentionOpenIds: readonly string[] = []): Record<string, unknown> {
  const allowed = new Set(allowedMentionOpenIds)
  // 格式转换会去掉表格的缩进，必须先在原文中保护缩进代码等字面标签。
  const elements = mentionElements(markdownForPost(protectPostMentionLiterals(markdown)), (openId, name) => allowed.has(openId)
    ? { tag: 'at', user_id: openId }
    : { tag: 'md', text: `${name || '未确认成员'}（未通知）` })
  const zh: Record<string, unknown> = { content: [elements] }
  if (title) zh.title = title
  return { zh_cn: zh }
}
