/**
 * Markdown → 飞书 docx 块（document.block.children.create 的 children）。
 * 只覆盖模型会写的那几种：标题、段落、无序/有序列表、任务项、引用、代码块、分割线；
 * 行内支持 **粗体**、`代码`、[文字](链接)。不认识的行按段落处理，绝不丢内容。
 */

export interface TextElement {
  text_run: { content: string; text_element_style?: { bold?: boolean; inline_code?: boolean; link?: { url: string } } }
}

export interface DocBlock {
  block_type: number
  [key: string]: unknown
}

const BLOCK_TYPE = { text: 2, heading: [3, 4, 5, 6, 7, 8, 9, 10, 11], bullet: 12, ordered: 13, code: 14, quote: 15, todo: 17, divider: 22 } as const

const CODE_LANG: Record<string, number> = { plaintext: 1, bash: 4, sh: 4, shell: 4, c: 8, cpp: 9, css: 11, go: 22, html: 24, java: 27, javascript: 28, js: 28, json: 29, kotlin: 32, markdown: 33, md: 33, python: 49, py: 49, rust: 53, sql: 56, typescript: 63, ts: 63, yaml: 66, yml: 66, xml: 65 }

/** 行内 markdown → text_run 元素。 */
export function inlineElements(line: string): TextElement[] {
  const out: TextElement[] = []
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text_run: { content: line.slice(last, m.index) } })
    if (m[2] !== undefined) out.push({ text_run: { content: m[2], text_element_style: { bold: true } } })
    else if (m[4] !== undefined) out.push({ text_run: { content: m[4], text_element_style: { inline_code: true } } })
    else if (m[6] !== undefined && m[7] !== undefined) out.push({ text_run: { content: m[6], text_element_style: { link: { url: m[7] } } } })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text_run: { content: line.slice(last) } })
  return out.length ? out : [{ text_run: { content: '' } }]
}

function textBlock(type: number, key: string, line: string, style?: Record<string, unknown>): DocBlock {
  return { block_type: type, [key]: { elements: inlineElements(line), ...(style ? { style } : {}) } }
}

export function markdownToBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: DocBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const trimmed = line.trim()
    if (!trimmed) {
      i += 1
      continue
    }
    const fence = trimmed.match(/^```\s*([\w+-]*)\s*$/)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i] as string)) {
        body.push(lines[i] as string)
        i += 1
      }
      i += 1 // 跳过结尾 ```
      const lang = CODE_LANG[(fence[1] ?? '').toLowerCase()] ?? 1
      blocks.push({ block_type: BLOCK_TYPE.code, code: { elements: [{ text_run: { content: body.join('\n') } }], style: { language: lang, wrap: true } } })
      continue
    }
    const heading = trimmed.match(/^(#{1,9})\s+(.*)$/)
    if (heading) {
      const level = (heading[1] as string).length
      const type = BLOCK_TYPE.heading[level - 1] as number
      blocks.push(textBlock(type, `heading${level}`, heading[2] as string))
      i += 1
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ block_type: BLOCK_TYPE.divider, divider: {} })
      i += 1
      continue
    }
    const todo = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/)
    if (todo) {
      blocks.push(textBlock(BLOCK_TYPE.todo, 'todo', todo[2] as string, { done: (todo[1] as string).toLowerCase() === 'x' }))
      i += 1
      continue
    }
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/)
    if (bullet) {
      blocks.push(textBlock(BLOCK_TYPE.bullet, 'bullet', bullet[1] as string))
      i += 1
      continue
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (ordered) {
      blocks.push(textBlock(BLOCK_TYPE.ordered, 'ordered', ordered[1] as string))
      i += 1
      continue
    }
    const quote = trimmed.match(/^>\s?(.*)$/)
    if (quote) {
      blocks.push(textBlock(BLOCK_TYPE.quote, 'quote', quote[1] as string))
      i += 1
      continue
    }
    // 普通段落：连续的非空、非特殊行合成一段
    const para: string[] = [trimmed]
    i += 1
    while (i < lines.length) {
      const next = (lines[i] as string).trim()
      if (!next || /^(#{1,9}\s|```|[-*+]\s|\d+[.)]\s|>|-{3,}$)/.test(next)) break
      para.push(next)
      i += 1
    }
    blocks.push(textBlock(BLOCK_TYPE.text, 'text', para.join(' ')))
  }
  return blocks
}
