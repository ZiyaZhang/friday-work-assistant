import type { TodoOrigin } from '../core/todo-provenance.js'
import { presentTodoOrigin } from '../core/todo-origin-presentation.js'
import { linkedGithubTitle } from '../core/github-links.js'

type Card = Record<string, unknown>

/** The actual Feishu SDK request body, including the escaped content string. */
export type TodoCardTransport =
  | { kind: 'create'; receiveId: string }
  | { kind: 'reply'; replyInThread: boolean }
  | { kind: 'patch' }

export interface TodoCardInput {
  title?: string
  items: { id: number; title: string; done: boolean; owner?: string | null; due?: string | null; note?: string | null; origin?: TodoOrigin | null; githubEvidence?: string }[]
  more?: number
  lede?: string
  footer?: string
  /** Zero-based view position; it is clamped after rebuilding from current Todos. */
  page?: number
  /** Production uses create + the real chat ID for stable create/reply/patch paging. */
  transport?: TodoCardTransport
}

export class TodoCardBudgetError extends Error {
  constructor(readonly code: 'separate_lede' | 'source_too_large' | 'item_too_large' | 'control_payload_too_large') {
    super({
      separate_lede: '正文与完整待办清单无法放在同一张卡里，请分别发送正文和可翻页清单。',
      source_too_large: '一条完整来源超过飞书卡片容量，无法在不截断来源的情况下展示。',
      item_too_large: '一条待办的展示内容超过飞书卡片容量。',
      control_payload_too_large: '清单的标题、说明或操作数据超过飞书卡片容量。',
    }[code])
    this.name = 'TodoCardBudgetError'
  }
}

function countTags(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countTags(child), 0)
  return (typeof (value as Card).tag === 'string' ? 1 : 0)
    + Object.values(value).reduce<number>((sum, child) => sum + countTags(child), 0)
}

/** Feishu counts nested tags, including text and icon tags, and limits the whole request to 30 KB. */
export function measureTodoCard(card: Card, transport: TodoCardTransport = { kind: 'patch' }): { bytes: number; tags: number; fits: boolean } {
  const content = JSON.stringify(card)
  const body = transport.kind === 'create' ? { receive_id: transport.receiveId, msg_type: 'interactive', content }
    : transport.kind === 'reply' ? { msg_type: 'interactive', content, reply_in_thread: transport.replyInThread }
      : { content }
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8'), tags = countTags(card)
  return { bytes, tags, fits: bytes <= 30_000 && tags <= 200 }
}

type Source = { lines: string[]; notice: string | null }
type Fragment = { item: number; start: number; end: number }
const ITEMS_PER_PAGE = 6

function plain(value: string): string { return value.replace(/</g, '＜').replace(/>/g, '＞') }
function title(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? normalized.slice(0, limit - 1) + '…' : normalized
}
function markdown(content: string): Card { return { tag: 'markdown', content } }

/** All view state is rebuilt from the current authorized Todo set; no saved card state or hidden source truncation. */
export function renderPagedTodoCard(input: TodoCardInput): Card {
  const ids = input.items.map(item => item.id), done = input.items.filter(item => item.done).length
  const sources: Source[] = input.items.map(item => {
    const origin = presentTodoOrigin(item.origin)
    return { lines: origin?.items.map(source => {
      const label = plain(source.label).replace(/[\\`*_\[\]()]/g, '\\$&')
      const url = source.url?.replace(/\(/g, '%28').replace(/\)/g, '%29')
      return `- ${url ? `[${label}](${url})` : label}`
    }) ?? [], notice: origin?.notice ?? null }
  })
  const tail: string[] = []
  if (input.more && input.more > 0) tail.push(`还有 ${input.more} 条没列在这张卡上`)
  if (input.footer) tail.push(input.footer)

  function render(fragments: Fragment[], page: number, pages: number): Card {
    const elements: Card[] = []
    if (input.lede?.trim()) elements.push(markdown(input.lede.trim()))
    for (const fragment of fragments) {
      const item = input.items[fragment.item]!, source = sources[fragment.item]!
      const meta = [item.owner, item.due].filter((part): part is string => Boolean(part && part.trim()))
      const line = meta.length ? `${title(item.title, 100)} · ${meta.join(' · ')}` : title(item.title, 120)
      elements.push({ tag: 'checker', checked: item.done, overall_checkable: false,
        text: { tag: 'lark_md', content: linkedGithubTitle(line, item.githubEvidence) }, checked_style: { show_strikethrough: true, opacity: 0.6 },
        behaviors: [{ type: 'callback', value: { action: 'todo', id: item.id, op: item.done ? 'reopen' : 'done', ids, page } }] })
      if (source.lines.length) {
        const lines = source.lines.slice(fragment.start, fragment.end)
        if (fragment.end === source.lines.length && source.notice) lines.push(`<font color="grey">${source.notice}</font>`)
        elements.push({ tag: 'collapsible_panel', expanded: false,
          header: { title: { tag: 'markdown', content: `<font color="grey">${fragment.start ? '来源续页' : '查看来源'}</font>` },
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
            icon_position: 'right', icon_expanded_angle: -180 },
          border: { color: 'grey', corner_radius: '6px' }, padding: '8px 8px 8px 8px', elements: [markdown(lines.join('\n'))] })
      }
    }
    if (!input.items.length) elements.push(markdown('<font color="grey">这份清单现在是空的。</font>'))
    if (tail.length) elements.push(markdown(`<font color="grey">${plain(tail.join('；'))}</font>`))
    if (pages > 1) {
      const columns: Card[] = []
      const navigation = (label: string, destination: number): Card => ({ tag: 'column', width: 'auto', elements: [{
        tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default', width: 'default',
        behaviors: [{ type: 'callback', value: { action: 'todo_page', page: destination, ids } }],
      }] })
      if (page > 0) columns.push(navigation('上一页', page - 1))
      columns.push({ tag: 'column', width: 'auto', elements: [markdown(`${page + 1}/${pages} 页`)] })
      if (page < pages - 1) columns.push(navigation('下一页', page + 1))
      elements.push({ tag: 'column_set', flex_mode: 'none', columns })
    }
    return { schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: input.title ?? '待办' },
        subtitle: { tag: 'plain_text', content: `${done}/${input.items.length} 已完成` },
        template: input.items.length && done === input.items.length ? 'green' : 'blue' }, body: { elements } }
  }

  const fits = (card: Card) => measureTodoCard(card, input.transport).fits
  const whole = input.items.map((_, item) => ({ item, start: 0, end: sources[item]!.lines.length }))
  const single = render(whole, 0, 1)
  if (whole.length <= ITEMS_PER_PAGE && fits(single)) return single
  // A callback must not carry the response body or silently lose it on refresh.
  // The host sends it separately, then renders this same list without a lede.
  if (input.lede?.trim()) throw new TodoCardBudgetError('separate_lede')

  // Each page consumes at least one item or one source. Reserve navigation using
  // that upper bound so final page-count digits and every callback ID are measured.
  const maxPages = Math.max(1, sources.reduce((sum, source) => sum + Math.max(1, source.lines.length), 0))
  const pages: Fragment[][] = []
  let current: Fragment[] = []
  const fitsPage = (fragments: Fragment[]) => fits(render(fragments, pages.length, maxPages))
  if (!fitsPage([])) throw new TodoCardBudgetError('control_payload_too_large')
  const nextPage = () => { pages.push(current); current = [] }
  for (let item = 0; item < input.items.length; item++) {
    if (current.length >= ITEMS_PER_PAGE) nextPage()
    const count = sources[item]!.lines.length
    let start = 0
    do {
      const fragment = { item, start, end: count }
      if (fitsPage([...current, fragment])) { current.push(fragment); break }
      let best = start
      if (count) {
        let low = start + 1, high = count
        while (low <= high) {
          const end = Math.floor((low + high) / 2)
          if (fitsPage([...current, { item, start, end }])) { best = end; low = end + 1 }
          else high = end - 1
        }
      }
      if (best > start) {
        current.push({ item, start, end: best }); start = best; nextPage()
      } else if (current.length) {
        nextPage()
      } else {
        throw new TodoCardBudgetError(count ? 'source_too_large' : 'item_too_large')
      }
    } while (true)
  }
  if (current.length) pages.push(current)
  if (!pages.length) throw new TodoCardBudgetError('control_payload_too_large')
  const requested = Number.isFinite(input.page) ? Math.trunc(input.page!) : 0
  const page = Math.min(pages.length - 1, Math.max(0, requested))
  const card = render(pages[page]!, page, pages.length)
  // Never rely on the packing estimate after final navigation is assembled.
  if (!fits(card)) throw new TodoCardBudgetError('control_payload_too_large')
  return card
}
