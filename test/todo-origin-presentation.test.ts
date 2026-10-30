import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleQueries } from '../src/core/console-queries.js'
import { ConsoleSessionStore } from '../src/core/console-sessions.js'
import { HumanSpaceAccess } from '../src/core/human-space-access.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { RoutineStore } from '../src/core/routines.js'
import { SkillProposals } from '../src/core/skills.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import { presentTodoOrigin } from '../src/core/todo-origin-presentation.js'
import type { TodoOrigin, TodoProvenance } from '../src/core/todo-provenance.js'
import { renderTodoCard } from '../src/feishu/cards.js'
import { consoleScript } from '../src/web/console-page.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const originalUrl = 'https://verified-message.example/original'
const attachmentUrl = 'https://verified-message.example/container'
function origin(): TodoOrigin {
  return { request: { kind: 'request', label: '原请求', link: { status: 'available', url: originalUrl } },
    selectedInputs: [{ kind: 'forward', label: '转发材料', link: { status: 'unavailable' } }],
    attachments: [{ kind: 'attachment', label: '附件已接收：问题报告.pdf', link: { status: 'available', url: attachmentUrl } }] }
}
function elements(card: Record<string, unknown>): Record<string, any>[] { return (card.body as { elements: Record<string, any>[] }).elements }
function sourcePanel(card: Record<string, unknown>) { return elements(card).find(item => item.tag === 'collapsible_panel') }

describe('one Todo origin presentation for cards and console', () => {
  it('keeps source links separate from the Todo completion action and uses one collapsed source section', () => {
    const card = renderTodoCard({ items: [{ id: 42, title: '跟进问题', done: false, origin: origin() }] })
    expect(elements(card)).toHaveLength(2)
    expect(elements(card)[0]!.behaviors).toEqual([{ type: 'callback', value: { action: 'todo', id: 42, op: 'done', ids: [42], page: 0 } }])
    const panel = sourcePanel(card)!
    expect(panel.expanded).toBe(false)
    expect(panel.header.title.content).toContain('查看来源')
    expect(panel.elements).toEqual([{ tag: 'markdown', content:
      `- [原请求](${originalUrl})\n- 转发材料\n- [附件已接收：问题报告.pdf](${attachmentUrl})\n<font color="grey">部分来源链接暂不可用。</font>` }])
    expect(JSON.stringify(panel)).not.toContain('已读取')
    expect(JSON.stringify(panel).match(/部分来源链接暂不可用/g)).toHaveLength(1)
  })

  it('preserves source-free legacy cards and does not create an empty background placeholder', () => {
    for (const value of [undefined, null, { request: null, selectedInputs: [], attachments: [] }]) {
      const card = renderTodoCard({ items: [{ id: 1, title: '旧待办', done: true, origin: value }] })
      expect(elements(card)).toHaveLength(1)
      expect(sourcePanel(card)).toBeUndefined()
      expect(JSON.stringify(card)).not.toContain('来源')
    }
  })

  it('consolidates repeated unavailable descriptions and reports missing links once', () => {
    const value = origin()
    value.request!.link = { status: 'unavailable' }
    value.attachments[0]!.link = { status: 'unavailable' }
    value.selectedInputs = Array.from({ length: 50 }, () => structuredClone(value.selectedInputs[0]!))
    const view = presentTodoOrigin(value)!
    expect(view.items).toHaveLength(3)
    expect(view.notice).toBe('来源链接暂不可用。')
    const panel = sourcePanel(renderTodoCard({ items: [{ id: 1, title: '待办', done: false, origin: value }] }))!
    expect(panel.elements).toHaveLength(1)
    for (const source of view.items) expect(panel.elements[0].content).toContain(source.label)
    expect(JSON.stringify(panel)).not.toContain('open_url')
  })

  it('never turns unsafe URLs or labels into card markup links and omits unknown source fields', () => {
    const value = origin()
    value.request!.link = { status: 'available', url: 'javascript:alert(1)' }
    value.selectedInputs[0]!.label = '<img src=x> [伪链接](javascript:alert(1))'
    Object.assign(value.request!, { messageId: 'PRIVATE_ORIGINAL_ID', contextSnapshot: 'PRIVATE_AUDIT' })
    const panel = sourcePanel(renderTodoCard({ items: [{ id: 1, title: '待办', done: false, origin: value }] }))!
    expect(panel.elements).toHaveLength(1)
    expect(panel.elements[0].content).toContain('＜img src=x＞ \\[伪链接\\]\\(javascript:alert\\(1\\)\\)')
    expect([...panel.elements[0].content.matchAll(/(?<!\\)\]\(([^)\s]+)\)/g)].map(match => match[1])).toEqual([attachmentUrl])
    expect(JSON.stringify(panel)).not.toContain('PRIVATE_')
  })


  it('returns only the stored origin projection through the authorized console query', async () => {
    const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
    const sp = spaceDeps(registry.db), group = sp.spaces.ensure({ kind: 'group', chatId: 'group-chat', openId: 'alice' })
    const sessions = new ConsoleSessionStore(registry.db), session = sessions.create({ appId: 'app', tenantKey: 'tenant', openId: 'alice', name: 'Alice' })
    const access = new HumanSpaceAccess({ ...sp, feishu: { chatMemberOpenIds: async () => new Set(['alice']) },
      assertActor: actor => { if (!sessions.isCurrent(actor)) throw new Error('expired') } })
    const todos = new Todos(registry.db)
    const message = { messageId: 'PRIVATE_ORIGINAL_ID', chatId: group.chatId!, chatType: 'group' as const, senderOpenId: 'alice',
      msgType: 'text', createTimeMs: 1000, link: { status: 'available' as const, url: originalUrl } }
    const provenance: TodoProvenance = { version: 1, originRunId: 'PRIVATE_RUN_ID', taskId: 1, workKey: 'PRIVATE_WORK', request: message,
      selectedInputs: [], contextSnapshot: { version: 1, acpSessionId: 'PRIVATE_ACP', spaceId: group.id, chatId: group.chatId!,
        chats: [], memoryScopes: [], repositories: [], external: [{ kind: 'web', ref: 'https://private.example/?opaque=PRIVATE_CREDENTIAL', access: 'link' }] } }
    const saved = todos.add({ scope: spaceScope(group.id), title: '当前空间的待办', source: '原请求', provenance })
    const legacy = todos.add({ scope: spaceScope(group.id), title: '旧待办' })
    const queries = new ConsoleQueries({ registry, access, todos, memory: new ChannelMemory(registry.db),
      routines: new RoutineStore(registry.db), skills: new SkillProposals(registry.db, new Set()), defaults: { brevity: 'normal', reflect: true } })
    const result = await queries.read(session.actor, group.id, 'tasks'); result.assertCurrent()
    const data = result.body.data as { items: { id: number; origin: TodoOrigin | null }[] }
    expect(data.items.find(item => item.id === saved.id)!.origin).toEqual(saved.origin)
    expect(data.items.find(item => item.id === legacy.id)!.origin).toBeNull()
    expect(JSON.stringify(data)).not.toContain('PRIVATE_')
    expect(JSON.stringify(data)).not.toContain('contextSnapshot')
    sp.spaces.rebind(group.id, 'changed-chat')
    expect(() => result.assertCurrent()).toThrow('空间状态或权限已变化')
  })
})

class Element {
  children: Element[] = []
  ownText = ''
  value = ''
  hidden = false
  className = ''
  href = ''
  target = ''
  rel = ''
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  listeners = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.ownText = String(value); this.children = [] }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_value: string) { throw new Error('Business content must not use innerHTML') }
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children; this.ownText = '' }
  setAttribute(key: string, value: string) { this.attrs[key] = value }
  removeAttribute(key: string) { delete this.attrs[key] }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener) }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]) }
}

async function browser(items: unknown[]) {
  const nodes = new Map<string, Element>()
  for (const id of ['content', 'spaces', 'workspace', 'login', 'logout', 'account', 'heading', 'description', 'notice', 'refresh']) nodes.set(id, new Element('div'))
  const tasks = new Element('button'); tasks.dataset.section = 'tasks'
  const document = { createElement: (tag: string) => new Element(tag), getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [tasks] }
  runInNewContext(consoleScript, { document, URL, AbortController, console,
    fetch: async (path: string) => path === '/console/api/me' ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, json: async () => ({ data: { items, total: items.length, truncated: false, todoStatus: 'active', routines: [] } }) } })
  await new Promise(resolve => setImmediate(resolve))
  nodes.get('spaces')!.value = 'space'
  tasks.listeners.get('click')!()
  await new Promise(resolve => setImmediate(resolve))
  expect(nodes.get('notice')!.textContent).toBe('')
  return nodes.get('content')!
}

describe('the actual console script renders Todo origins with safe DOM links', () => {
  it('matches the card labels and link destinations while keeping markup-shaped names as text', async () => {
    const value = origin()
    value.attachments[0]!.label = '附件已接收：<img src=x onerror=alert(1)> [文件].pdf'
    const content = await browser([{ id: 1, title: '当前待办', status: 'open', statusLabel: '进行中', confirmed: true, canEdit: false, origin: value }])
    const descendants = content.descendants(), links = descendants.filter(node => node.tag === 'a')
    const view = presentTodoOrigin(value)!
    expect(links.map(node => ({ label: node.textContent, url: node.href }))).toEqual(view.items.filter(item => item.url))
    for (const link of links) expect([link.target, link.rel]).toEqual(['_blank', 'noopener noreferrer'])
    expect(descendants.filter(node => node.tag === 'details')).toHaveLength(1)
    expect(descendants.some(node => node.tag === 'img')).toBe(false)
    expect(content.textContent).toContain(value.attachments[0]!.label)
    expect(content.textContent.match(/部分来源链接暂不可用/g)).toHaveLength(1)
    const card = renderTodoCard({ items: [{ id: 1, title: '当前待办', done: false, origin: value }] })
    expect([...sourcePanel(card)!.elements[0].content.matchAll(/(?<!\\)\]\(([^)\s]+)\)/g)].map(match => match[1]))
      .toEqual(links.map(node => node.href))
    expect(sourcePanel(card)!.elements[0].content).toContain('附件已接收：＜img src=x onerror=alert\\(1\\)＞ \\[文件\\].pdf')
  })

  it('does not guess links, display raw IDs, or add source sections to legacy rows', async () => {
    const value = origin()
    value.request!.link = { status: 'available', url: 'javascript:alert(1)' }
    value.attachments = []
    Object.assign(value, { messageId: 'PRIVATE_ORIGINAL_ID', contextSnapshot: 'PRIVATE_CONTEXT' })
    const content = await browser([
      { title: '待办', statusLabel: '进行中', confirmed: true, canEdit: false, origin: value },
      { title: '旧待办', statusLabel: '进行中', confirmed: true, canEdit: false, origin: null },
    ])
    expect(content.descendants().filter(node => node.tag === 'a')).toHaveLength(0)
    expect(content.descendants().filter(node => node.tag === 'details')).toHaveLength(1)
    expect(content.textContent.match(/来源链接暂不可用/g)).toHaveLength(1)
    expect(content.textContent).not.toContain('PRIVATE_')
    expect(content.textContent).not.toContain('javascript:')
  })
})
