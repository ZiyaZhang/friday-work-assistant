import { describe, expect, it } from 'vitest'
import { chunkMarkdown, markdownForPost, postContent, stripMarkdown } from '../src/feishu/post.js'

describe('post (rich text) conversion', () => {
  it('turns headings into bold lines, flattens tables, keeps code fences', () => {
    const md = ['# 结论', '', '| 项 | 值 |', '|---|---|', '| a | 1 |', '', '```bash', '# not a heading', 'ls', '```', '<font color="grey">注</font>'].join('\n')
    const out = markdownForPost(md)
    expect(out).toContain('**结论**')
    expect(out).toContain('项 · 值')
    expect(out).toContain('a · 1')
    expect(out).not.toContain('|---|')
    expect(out).toContain('# not a heading')
    expect(out).toContain('注')
    expect(out).not.toContain('<font')
  })

  it('strips markdown for the plain-text fallback', () => {
    const t = stripMarkdown('## 标题\n- **粗** `code` [链](https://x.y)\n> 引用\n```\nraw\n```')
    expect(t).toBe('标题\n• 粗 code 链（https://x.y）\n引用\nraw')
  })

  it('chunks long bodies by line and keeps code blocks closed', () => {
    const lines: string[] = ['```js']
    for (let i = 0; i < 120; i++) lines.push(`const v${i} = ${'x'.repeat(40)}`)
    lines.push('```', '尾巴')
    const chunks = chunkMarkdown(lines.join('\n'), 2000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000 + 8)
      expect((c.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks.at(-1)).toContain('尾巴')
    expect(chunkMarkdown('短', 100)).toEqual(['短'])
    expect(chunkMarkdown('', 100)).toEqual([])
  })

  it('builds post content with a single md paragraph', () => {
    const c = postContent('**hi**', 't') as { zh_cn: { title?: string; content: { tag: string; text: string }[][] } }
    expect(c.zh_cn.title).toBe('t')
    expect(c.zh_cn.content[0]?.[0]).toEqual({ tag: 'md', text: '**hi**' })
    expect((postContent('x') as { zh_cn: { title?: string } }).zh_cn.title).toBeUndefined()
  })

  function nodes(markdown: string, allowed = ['ou_proposer', 'ou_owner']) {
    return (postContent(markdown, undefined, allowed) as { zh_cn: { content: { tag: string; user_id?: string; text?: string }[][] } }).zh_cn.content.flat()
  }

  it('renders verified whois mentions as native post nodes while preserving surrounding Markdown', () => {
    expect(nodes('<at open_id="ou_proposer">提出人</at> 已记到 [Issue](https://example.invalid/1)：**建议**。请 <at open_id="ou_owner"></at> 评估。')).toEqual([
      { tag: 'at', user_id: 'ou_proposer' },
      { tag: 'md', text: ' 已记到 [Issue](https://example.invalid/1)：**建议**。请 ' },
      { tag: 'at', user_id: 'ou_owner' },
      { tag: 'md', text: ' 评估。' },
    ])
  })

  it('requires a host allowlist and degrades an unverified person to a name without claiming notification', () => {
    expect(nodes('<at open_id="ou_outside">群外人员</at> 请看下', [])).toEqual([{ tag: 'md', text: '群外人员（未通知） 请看下' }])
    const plain = postContent('<at open_id="ou_owner">负责人</at>')
    expect(JSON.stringify(plain)).not.toContain('"tag":"at"')
    expect(JSON.stringify(plain)).toContain('负责人（未通知）')
  })

  it.each([
    '```html\n<at open_id="ou_owner">负责人</at>\n```',
    '~~~~html\n<at open_id="ou_owner">负责人</at>\n~~~\n<at open_id="ou_owner">负责人</at>\n~~~~',
    '> 引用\n<at open_id="ou_owner">负责人</at>',
    '    <at open_id="ou_owner">负责人</at>',
    '行内 `<at open_id="ou_owner">负责人</at>` 示例',
    '行内 ``代码含 ` <at open_id="ou_owner">负责人</at>``',
    '跨行 `代码\n<at open_id="ou_owner">负责人</at>\n结束`',
    '原话：“<at open_id="ou_owner">负责人</at> 请看下”',
    '[<at open_id="ou_owner">负责人</at>](https://example.invalid)',
    '\\<at open_id="ou_owner">负责人</at>',
  ])('does not notify from quoted or code source: %s', (input) => {
    const result = nodes(input)
    expect(result.every((n) => n.tag === 'md')).toBe(true)
    expect(result.map((n) => n.text).join('')).toContain('负责人')
    expect(result.map((n) => n.text).join('')).not.toContain('<at')
  })

  it.each(['all', 'ou_', 'ou_bad id', 'ou_x" extra="y', 'ou_中文', 'ou_' + 'a'.repeat(129)])('never promotes malformed/all ids even if included in a host list: %s', (id) => {
    expect(nodes(`<at open_id="${id}">人</at>`, [id]).some((n) => n.tag === 'at')).toBe(false)
  })

  it('neutralizes raw platform user_id/all markup instead of bypassing the verified whois format', () => {
    const result = nodes('<at user_id="all">全部</at> <at user_id="ou_owner">负责人</at>')
    expect(result.every((n) => n.tag === 'md')).toBe(true)
    expect(result.map((n) => n.text).join('')).not.toContain('<at')
  })

  it('resumes intentional mentions after a quoted paragraph or fenced block ends', () => {
    const result = nodes('> 原话 <at open_id="ou_owner">负责人</at>\n\n```\n示例\n```\n<at open_id="ou_owner">负责人</at> 请评估。')
    expect(result.filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_owner' }])
  })

  it.each([
    '原话：“\n<at open_id="ou_owner">负责人</at> 请看下\n”',
    '原话：「\n<at open_id="ou_owner">负责人</at> 请看下\n」',
    '原话：“\n“嵌套原话” <at open_id="ou_owner">负责人</at>\n”',
    '    | <at open_id="ou_owner">负责人</at> |',
    '[<at open_id="ou_owner">负责人</at>][person]\n\n[person]: https://example.invalid',
  ])('keeps original quote/code/reference-link semantics before post conversion and chunking: %s', (literal) => {
    const input = `${literal}\n\n<at open_id="ou_proposer">提出人</at> 已记录。`
    for (const parts of [[input], chunkMarkdown(input, 50)]) {
      const encoded = parts.flatMap((part) => nodes(part))
      expect(encoded.filter((n) => n.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_proposer' }])
      expect(encoded.map((n) => n.text).join('')).toContain('负责人')
    }
  })

  it.each(['code', 'quote', 'inline-code'] as const)('protects a literal %s mention before a long line is split across chunks', (kind) => {
    const literal = 'x'.repeat(3800) + '<at open_id="ou_owner">负责人</at>' + 'y'.repeat(3800)
    const quoted = kind === 'code' ? `\`\`\`html\n${literal}\n\`\`\`` : kind === 'quote' ? `> ${literal}` : `\`${literal}\``
    const chunks = chunkMarkdown(quoted)
    expect(chunks.length).toBeGreaterThan(1)
    const encoded = chunks.flatMap((chunk) => nodes(chunk))
    expect(encoded.filter((n) => n.tag === 'at')).toEqual([])
    expect(encoded.map((n) => n.text).join('')).toContain('负责人')
  })
})
