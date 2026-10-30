import { describe, expect, it } from 'vitest'
import { inlineElements, markdownToBlocks } from '../src/feishu/docblocks.js'

describe('markdown → docx blocks', () => {
  it('maps headings, lists, todos, quotes, code, dividers and paragraphs', () => {
    const md = ['# 标题', '', '第一段', '还是第一段', '', '- 无序 **重点**', '1. 有序', '- [ ] 待办', '- [x] 已办', '> 引用', '---', '```ts', 'const a = 1', '```', '## 二级', '尾段 `code` [链接](https://x.y/z)'].join('\n')
    const blocks = markdownToBlocks(md)
    expect(blocks.map((b) => b.block_type)).toEqual([3, 2, 12, 13, 17, 17, 15, 22, 14, 4, 2])
    const para = blocks[1] as { text: { elements: { text_run: { content: string } }[] } }
    expect(para.text.elements[0]?.text_run.content).toBe('第一段 还是第一段')
    const bullet = blocks[2] as { bullet: { elements: { text_run: { content: string; text_element_style?: { bold?: boolean } } }[] } }
    expect(bullet.bullet.elements.map((e) => e.text_run.content)).toEqual(['无序 ', '重点'])
    expect(bullet.bullet.elements[1]?.text_run.text_element_style?.bold).toBe(true)
    const done = blocks[5] as { todo: { style: { done: boolean } } }
    expect(done.todo.style.done).toBe(true)
    const code = blocks[8] as { code: { elements: { text_run: { content: string } }[]; style: { language: number } } }
    expect(code.code.elements[0]?.text_run.content).toBe('const a = 1')
    expect(code.code.style.language).toBe(63)
    const last = blocks[10] as { text: { elements: { text_run: { content: string; text_element_style?: { inline_code?: boolean; link?: { url: string } } } }[] } }
    expect(last.text.elements.map((e) => e.text_run.content)).toEqual(['尾段 ', 'code', ' ', '链接'])
    expect(last.text.elements[1]?.text_run.text_element_style?.inline_code).toBe(true)
    expect(last.text.elements[3]?.text_run.text_element_style?.link?.url).toBe('https://x.y/z')
  })

  it('never drops content and handles empty input', () => {
    expect(markdownToBlocks('')).toEqual([])
    expect(inlineElements('')).toEqual([{ text_run: { content: '' } }])
    const blocks = markdownToBlocks('```\nunterminated code')
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { code: { elements: { text_run: { content: string } }[] } }).code.elements[0]?.text_run.content).toBe('unterminated code')
  })
})
