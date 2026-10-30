import { describe, expect, it } from 'vitest'
import { renderTodoCard, TodoCardBudgetError, type TodoCardTransport } from '../src/feishu/cards.js'
import { measureTodoCard, type TodoCardInput } from '../src/feishu/todo-card-pagination.js'
import { presentTodoOrigin } from '../src/core/todo-origin-presentation.js'

type Card = Record<string, any>
const transport: TodoCardTransport = { kind: 'create', receiveId: `oc_${'a'.repeat(32)}` }
function nodes(value: unknown): Card[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nodes)
  return [value as Card, ...Object.values(value).flatMap(nodes)]
}
function callbacks(card: Card): Card[] { return nodes(card).filter(node => node.type === 'callback').map(node => node.value) }
function checkers(card: Card): Card[] { return nodes(card).filter(node => node.tag === 'checker') }
function links(card: Card): string[] {
  return nodes(card).filter(node => node.tag === 'markdown').flatMap(node =>
    [...node.content.matchAll(/(?<!\\)\]\(([^)\s]+)\)/g)].map(match => match[1]))
}
function allPages(input: TodoCardInput): Card[] {
  const cards: Card[] = []
  let page = 0
  for (;;) {
    const card = renderTodoCard({ ...input, page }); cards.push(card)
    const next = callbacks(card).find(value => value.action === 'todo_page' && value.page > page)
    if (!next) return cards
    expect(next.page).toBe(page + 1)
    page = next.page
    if (page > 10_000) throw new Error('Paging failed to make progress')
  }
}
function sourceUrl(item: number, source: number): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=oc_${item.toString(16).padStart(32, '0')}&position=${1_800_000_000_000 + source}`
}
function items(count: number, sources: number): TodoCardInput['items'] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `待办 ${index + 1}：${'验收'.repeat(50)}`, done: false,
    origin: { request: { kind: 'request', label: '原请求', link: { status: 'available', url: sourceUrl(index, 0) } },
      selectedInputs: Array.from({ length: sources }, (_, source) => ({ kind: 'forward', label: `选中的转发材料 ${source + 1}`,
        link: { status: 'available', url: sourceUrl(index, source + 1) } })), attachments: [] } }))
}
function expectedLinks(value: TodoCardInput['items']): string[] {
  return value.flatMap(item => presentTodoOrigin(item.origin)?.items.flatMap(source => source.url ? [source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')] : []) ?? [])
}
function assertBudget(card: Card, target: TodoCardTransport = transport) {
  const content = JSON.stringify(card)
  const outer = target.kind === 'create' ? { receive_id: target.receiveId, msg_type: 'interactive', content }
    : target.kind === 'reply' ? { msg_type: 'interactive', content, reply_in_thread: target.replyInThread } : { content }
  // Independent assertions on the final serialized SDK payload, not packing estimates.
  const final = JSON.parse(JSON.stringify(outer))
  const tags = nodes(JSON.parse(final.content)).filter(node => typeof node.tag === 'string').length
  const bytes = Buffer.byteLength(JSON.stringify(final), 'utf8')
  expect(bytes).toBeLessThanOrEqual(30_000)
  expect(tags).toBeLessThanOrEqual(200)
  expect(measureTodoCard(card, target)).toEqual({ bytes, tags, fits: true })
}

describe('Todo cards page against the complete Feishu request budget', () => {
  it('keeps every item and source URL in the real 20-item ancestor fixture, with complete callbacks', () => {
    const value = items(20, 4), cards = allPages({ items: value, transport })
    expect(cards.length).toBeGreaterThan(1)
    expect(cards.flatMap(links)).toEqual(expectedLinks(value))
    expect(new Set(cards.flatMap(checkers).map(node => node.behaviors[0].value.id))).toEqual(new Set(value.map(item => item.id)))
    for (const [page, card] of cards.entries()) {
      assertBudget(card)
      for (const callback of callbacks(card)) {
        expect(callback.ids).toEqual(value.map(item => item.id))
        if (callback.action === 'todo') expect(callback.page).toBe(page)
      }
      const navigation = callbacks(card).filter(value => value.action === 'todo_page').map(value => value.page)
      expect(navigation).toEqual([...(page ? [page - 1] : []), ...(page < cards.length - 1 ? [page + 1] : [])])
    }
  })

  it('splits a single Todo with many sources into titled continuation pages without losing links or unknown-source notice', () => {
    const value = items(1, 240)
    value[0]!.origin!.selectedInputs.push({ kind: 'forward', label: '原链接暂不可用的材料', link: { status: 'unavailable' } })
    const cards = allPages({ items: value, transport })
    expect(cards.length).toBeGreaterThan(1)
    expect(cards.flatMap(links)).toEqual(expectedLinks(value))
    expect(cards.flatMap(card => nodes(card).filter(node => node.tag === 'markdown' && node.content.includes('部分来源链接暂不可用')))).toHaveLength(1)
    const titles = cards.flatMap(checkers).map(node => node.text.content)
    expect(new Set(titles).size).toBe(1)
    for (const [page, card] of cards.entries()) {
      assertBudget(card)
      expect(checkers(card)).toHaveLength(1)
      expect(JSON.stringify(card)).toContain(page ? '来源续页' : '查看来源')
    }
  })

  it('keeps the reading page short while preserving every item and source over pages', () => {
    const value: TodoCardInput['items'] = Array.from({ length: 34 }, (_, id) => ({ id: id + 1, title: 'T', done: false,
      origin: { request: { kind: 'request', label: 'R', link: { status: 'available', url: 'https://a.co' } }, selectedInputs: [], attachments: [] } }))
    const cards = allPages({ items: value, transport })
    expect(cards.length).toBeGreaterThan(1)
    expect(checkers(cards[0]!)).toHaveLength(6)
    expect(measureTodoCard(cards[0]!, transport).bytes).toBeLessThan(30_000)
    expect(cards.flatMap(checkers).map(node => node.behaviors[0].value.id)).toEqual(value.map(item => item.id))
    for (const card of cards) assertBudget(card)
    expect(allPages({ items: value.slice(0, 21).map(item => ({ ...item, origin: null })), transport })).toHaveLength(4)
  })

  it('preserves all received-attachment links as well as original and selected message links over multiple pages', () => {
    const value = items(20, 4)
    for (const [index, item] of value.entries()) item.origin!.attachments = Array.from({ length: 4 }, (_, source) => ({
      kind: 'attachment', label: `附件已接收：材料 ${source + 1}.pdf`,
      link: { status: 'available', url: `https://example.com/${index}/file-${source}?position=(original)` },
    }))
    const cards = allPages({ items: value, transport, footer: '可在清单内更新完成状态。' })
    expect(cards.length).toBeGreaterThan(1)
    expect(cards.flatMap(links)).toEqual(expectedLinks(value))
    expect(cards.flatMap(links)).toHaveLength(180)
    for (const card of cards) { assertBudget(card); expect(JSON.stringify(card)).not.toContain('附件已读取') }
  })

  it('accepts the exact transport boundaries and rejects one byte or one nested tag more', () => {
    const card = { tag: 'markdown', content: '' }
    card.content = 'x'.repeat(30_000 - measureTodoCard(card, transport).bytes)
    expect(measureTodoCard(card, transport)).toEqual({ bytes: 30_000, tags: 1, fits: true })
    expect(measureTodoCard({ ...card, content: card.content + 'x' }, transport).fits).toBe(false)
    const nested = { header: { title: { tag: 'plain_text', content: 'T' } },
      elements: Array.from({ length: 199 }, () => ({ tag: 'markdown', content: 'x' })) }
    expect(measureTodoCard(nested, transport)).toMatchObject({ tags: 200, fits: true })
    nested.elements.push({ tag: 'markdown', content: 'x' })
    expect(measureTodoCard(nested, transport)).toMatchObject({ tags: 201, fits: false })
  })

  it('measures UTF-8 and outer JSON escaping, including the actual target and callback payload', () => {
    const value = items(20, 4)
    for (const item of value) item.owner = '姓名"\\换行\n'.repeat(20)
    const target: TodoCardTransport = { kind: 'create', receiveId: '收件人"\\\n'.repeat(100) }
    const cards = allPages({ items: value, transport: target })
    expect(cards.length).toBeGreaterThan(1)
    for (const card of cards) {
      assertBudget(card, target)
      expect(measureTodoCard(card, target).bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(card), 'utf8'))
    }
    const card = cards[0]!
    assertBudget(card, { kind: 'reply', replyInThread: true })
    assertBudget(card, { kind: 'patch' })
  })

  it('keeps a one-page lede and explicitly asks the host to separate it when paging is necessary', () => {
    const lede = '原始完整正文。'
    expect(JSON.stringify(renderTodoCard({ items: items(1, 1), lede, transport }))).toContain(lede)
    for (const input of [{ items: items(20, 4), lede }, { items: items(1, 1), lede: '字'.repeat(30_000) }]) {
      expect(() => renderTodoCard({ ...input, transport })).toThrow(TodoCardBudgetError)
      try { renderTodoCard({ ...input, transport }) } catch (error) { expect((error as TodoCardBudgetError).code).toBe('separate_lede') }
    }
  })

  it('fails explicitly when one source cannot fit instead of clipping or inventing a destination', () => {
    const value = items(1, 0)
    value[0]!.origin!.request!.link = { status: 'available', url: `https://example.com/${'x'.repeat(32_000)}` }
    expect(() => renderTodoCard({ items: value, transport })).toThrow(TodoCardBudgetError)
    try { renderTodoCard({ items: value, transport }) } catch (error) { expect((error as TodoCardBudgetError).code).toBe('source_too_large') }
  })

  it('rejects oversized fixed content rather than silently omitting it', () => {
    expect(() => renderTodoCard({ items: items(2, 1), footer: '字'.repeat(30_000), transport })).toThrow(TodoCardBudgetError)
  })

  it('rebuilds and clamps the page after authorized item changes, with no body or title stored in callbacks', () => {
    const value = items(20, 4), cards = allPages({ items: value, transport })
    expect(renderTodoCard({ items: value, transport, page: 999 })).toEqual(cards.at(-1))
    expect(renderTodoCard({ items: value, transport, page: -1 })).toEqual(cards[0])
    const current = [{ ...value[0]!, done: true }]
    const changed = renderTodoCard({ items: current, transport, page: 999 })
    expect(checkers(changed)[0]!.checked).toBe(true)
    expect(callbacks(changed)).toEqual([{ action: 'todo', id: current[0]!.id, op: 'reopen', ids: [current[0]!.id], page: 0 }])
    expect(JSON.stringify(callbacks(changed))).not.toContain('正文')
  })
})
