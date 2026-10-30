import { expect, it } from 'vitest'
import { renderDigestCard } from '../src/feishu/cards.js'

it('keeps native emoji and real links, renders separate sections, and folds only later details', () => {
  const card = renderDigestCard({ title: '早报', conclusion: '两项进展，一项待确认。', fold: true,
    body: '## :THUMBSUP: 进展\n- **已完成**：[事项](https://example.com/issue/1)\n\n## :OK: 待确认\n- 排期仍待确认。' }) as any
  expect(card.body.elements.map((e: any) => e.tag)).toEqual(['markdown', 'hr', 'markdown', 'collapsible_panel'])
  expect(card.body.elements[2].content).toContain('**:THUMBSUP: 进展**')
  expect(card.body.elements[2].content).toContain('[事项](https://example.com/issue/1)')
  expect(card.body.elements[3]).toMatchObject({ expanded: false, header: { title: { content: '更多详情' } } })
  expect(card.body.elements[3].elements[0].content).toContain(':OK:')
})

it('does not split or rewrite headings inside code fences', () => {
  const card = renderDigestCard({ title: '报告', conclusion: '', body: '## 进展\n```sh\n## shell comment\necho ok\n```\n## 风险\n无' }) as any
  expect(card.body.elements.filter((e: any) => e.tag === 'markdown')).toHaveLength(2)
  expect(card.body.elements[0].content).toContain('```sh\n## shell comment\necho ok\n```')
})
