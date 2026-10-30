import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope, type Space } from '../src/core/space.js'
import { Todos, type Todo } from '../src/core/todos.js'
import type { TodoProvenance } from '../src/core/todo-provenance.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import { measureTodoCard } from '../src/feishu/todo-card-pagination.js'
import { chunkMarkdown } from '../src/feishu/post.js'
import { shouldFold } from '../src/feishu/cards.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { deferred } from './helpers/model-agent.js'
import { spaceDeps } from './helpers/space.js'

type Card = Record<string, unknown>
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

function nodes(value: unknown): Card[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nodes)
  return [value as Card, ...Object.values(value).flatMap(nodes)]
}
function callbacks(card: Card, action: string) {
  return nodes(card).filter(node => node.type === 'callback' && (node.value as Card | undefined)?.action === action)
    .map(node => node.value as Card)
}
function checkers(card: Card) { return nodes(card).filter(node => node.tag === 'checker') }
function next(card: Card): Card | undefined {
  const button = nodes(card).find(node => node.tag === 'button' && (node.text as Card | undefined)?.content === '下一页')
  return button ? callbacks(button, 'todo_page')[0] : undefined
}
function returnedCard(result: unknown): Card {
  expect(result).toMatchObject({ card: { type: 'raw', data: expect.any(Object) } })
  return (result as { card: { type: 'raw'; data: Card } }).card.data
}
function action(value: Card, chatId = 'synthetic-group', operator = 'alice', messageId = 'synthetic-card') {
  // Actual normalized provider context wins over any fields embedded in callback value.
  return normalizeCardAction({ context: { open_chat_id: chatId, open_message_id: messageId },
    operator: { open_id: operator }, action: { value,
      ...(value.action === 'todo' ? { tag: 'checker', checked: true } : { tag: 'button' }) } })
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-todo-card-host-')), dbPath = join(home, 'friday.db')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  closes.push(async () => { rmSync(home, { recursive: true, force: true }) })
  const open = () => {
    const registry = new Registry(dbPath), todos = new Todos(registry.db), memory = new ChannelMemory(registry.db)
    const sp = spaceDeps(registry.db), group = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'alice' })
    sp.spaces.addMember(group.id, 'bob', 'member')
    const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'synthetic-dm-alice', openId: 'alice' })
    const otherDm = sp.spaces.ensure({ kind: 'p2p', chatId: 'synthetic-dm-bob', openId: 'bob' })
    const fake = new FakeFeishu(); fake.members.set('synthetic-group', new Set(['alice', 'bob']))
    const feishu = asFeishuClient(fake), log = createLogger('todo-card-host', 'error')
    const cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
    const tokens = new TokenIssuer('synthetic-signing'), execution = managedHostRuntime(registry, home, log)
    const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, feishu, messages, tokens,
      runtime: execution.runtime, managed: execution.managed,
      ingressClassifier: { classify: async () => ({ kind: 'new_work' }) },
      apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
    let closed = false, serial = 0
    const close = async () => { if (closed) return; closed = true; await execution.runtime.stop(); registry.close() }
    closes.push(close)
    function seed(count: number, options: { space?: Space; owner?: string; sources?: number; titlePrefix?: string } = {}) {
      const space = options.space ?? group, owner = options.owner ?? 'alice', sourceCount = options.sources ?? 3
      const sessionKey = `seed-session-${space.id}-${++serial}`
      registry.createSession({ sessionKey, chatId: space.chatId!, chatType: space.kind, requesterOpenId: owner,
        cwd: cfg.workspace.root, rootMessageId: `seed-root-${serial}` })
      return Array.from({ length: count }, (_, index) => {
        const id = serial * 1000 + index + 1, requestId = `seed-request-${id}`
        const metadata = (messageId: string, position: number) => ({ messageId, chatId: space.chatId!, chatType: space.kind,
          senderOpenId: owner, msgType: 'merge_forward', createTimeMs: 1_700_000_000_000 + position,
          link: { status: 'available' as const, url: `https://applink.feishu.cn/client/chat/open?openChatId=${space.chatId}&position=${position}` } })
        const provenance: TodoProvenance = { version: 1, originRunId: `seed-run-${id}`, taskId: id, workKey: `task:${id}`,
          request: metadata(requestId, id), selectedInputs: Array.from({ length: sourceCount }, (_, offset) => ({
            ref: `seed-ref-${id}-${offset}`, taskId: id + 100_000 + offset,
            message: metadata(`seed-material-${id}-${offset}`, id * 100 + offset),
          })), contextSnapshot: { version: 1, acpSessionId: `seed-acp-${id}`, spaceId: space.id, chatId: space.chatId!,
            memoryScopes: [spaceScope(space.id)], chats: [], external: [], repositories: [] } }
        return todos.add({ scope: spaceScope(space.id), title: `${options.titlePrefix ?? '合成待办'} ${id}`,
          detail: `合成完整详情 ${id}`, sessionKey, createdBy: owner, provenance })
      })
    }
    const snapshot = () => registry.db.prepare('SELECT * FROM todos ORDER BY id').all()
    return { cfg, registry, todos, ...sp, group, dm, otherDm, fake, host, tokens, execution, seed, snapshot, close,
      restart: async () => { await close(); return open() } }
  }
  return open()
}

describe('Todo pagination through actual host callback actions', () => {
  it('acknowledges only changed items after reading the backlog to avoid duplicates', async () => {
    const t = fixture(), items = t.seed(17)
    t.execution.peer.state.script = [{ kind: 'hook', run: () => {
      const servers = t.execution.peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = t.tokens.verify(servers[0]!.env.find(value => value.name === 'FRIDAY_CAP_TOKEN')!.value)!
      t.host.abilities.notedTodos(cap, items.map(item => item.id))
      t.host.abilities.notedTodos(cap, [items[16]!.id], 'write')
      t.host.abilities.notedTodos(cap, items.map(item => item.id))
    } }, { kind: 'text', text: '今天 20:00 截止。' }]
    await t.host.handleMessage({ eventId: 'one-change', messageId: 'one-change', chatId: t.group.chatId!,
      chatType: 'group', msgType: 'text', text: '修改刚才那条待办的截止时间。', senderOpenId: 'alice', senderType: 'user',
      mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), tenantId: 'synthetic-tenant' })
    const card = t.fake.of('replyCard').at(-1)!.payload as Card
    expect(callbacks(card, 'todo').map(value => value.id)).toEqual([items[16]!.id])
    expect(t.todos.count(spaceScope(t.group.id), { status: 'all' })).toBe(17)
  })
  it('returns pages without changing business rows, and a fresh host can continue the original card after reopening the DB', async () => {
    let t = fixture()
    const items = t.seed(45), before = t.snapshot()
    let card = t.host.todoCard(items, 0, undefined, 0, { kind: 'create', receiveId: t.group.chatId! })
    const requested = next(card)
    expect(requested?.page).toBe(1)
    const originalIds = callbacks(card, 'todo')[0]!.ids
    t = await t.restart()
    card = returnedCard(await t.host.handleCardAction(action(requested!)))
    expect(t.fake.of('patchCard')).toHaveLength(0)
    expect(t.fake.sent).toEqual([])
    expect(t.snapshot()).toEqual(before)
    expect(callbacks(card, 'todo')[0]).toMatchObject({ page: 1, ids: originalIds })
    expect(measureTodoCard(card).fits).toBe(true)
    const previous = callbacks(card, 'todo_page').find(value => value.page === 0)!
    const previousCard = returnedCard(await t.host.handleCardAction(action(previous)))
    expect(callbacks(previousCard, 'todo')[0]!.page).toBe(0)
    expect(t.fake.of('patchCard')).toHaveLength(0)
    expect(t.snapshot()).toEqual(before)
    expect(t.execution.peer.state.allPrompts).toHaveLength(0)
  })

  it('updates the later-page checkbox by its original ID and preserves that page and all source fragments', async () => {
    const t = fixture(), items = t.seed(45)
    const first = t.host.todoCard(items, 0, undefined, 0, { kind: 'create', receiveId: t.group.chatId! })
    const later = returnedCard(await t.host.handleCardAction(action(next(first)!)))
    const checkbox = callbacks(later, 'todo')[0]!, id = Number(checkbox.id)
    expect(id).not.toBe(items[0]!.id)
    const before = t.todos.get(id)!, proof = t.todos.getProvenance(id)
    const sourcesBefore = nodes(later).filter(node => node.tag === 'collapsible_panel')
    const result = await t.host.handleCardAction(action(checkbox))
    expect(result).toMatchObject({ toast: { type: 'success' } })
    const after = t.todos.get(id)!, refreshed = returnedCard(result)
    expect(after).toMatchObject({ id, title: before.title, detail: before.detail, status: 'done', createdAt: before.createdAt })
    expect(t.todos.getProvenance(id)).toEqual(proof)
    expect(callbacks(refreshed, 'todo')[0]!.page).toBe(1)
    expect(checkers(refreshed).find(node => callbacks(node, 'todo')[0]?.id === id)?.checked).toBe(true)
    expect(nodes(refreshed).filter(node => node.tag === 'collapsible_panel')).toEqual(sourcesBefore)
    expect(t.todos.count(spaceScope(t.group.id), { status: 'done' })).toBe(1)
    expect(t.todos.count(spaceScope(t.group.id), { status: 'all' })).toBe(items.length)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })

  it('returns the authoritative card even when the platform patch API is unavailable', async () => {
    const t = fixture(), items = t.seed(45)
    const later = t.host.todoCard(items, 0, undefined, 1, { kind: 'create', receiveId: t.group.chatId! })
    const checkbox = callbacks(later, 'todo')[0]!, id = Number(checkbox.id), proof = t.todos.getProvenance(id)
    const patch = vi.spyOn(t.fake, 'patchCard').mockRejectedValue(new Error('synthetic patch unavailable'))
    const result = await t.host.handleCardAction(action(checkbox))
    expect(result).toMatchObject({ toast: { type: 'success', content: '已完成' } })
    expect(t.todos.get(id)?.status).toBe('done')
    expect(t.todos.getProvenance(id)).toEqual(proof)
    expect(checkers(returnedCard(result)).find(node => callbacks(node, 'todo')[0]?.id === id)?.checked).toBe(true)
    const page = returnedCard(await t.host.handleCardAction(action({ action: 'todo_page', ids: items.map(item => item.id), page: 1 })))
    expect(checkers(page).find(node => callbacks(node, 'todo')[0]?.id === id)?.checked).toBe(true)
    expect(callbacks(page, 'todo')[0]!.page).toBe(1)
    expect(patch).not.toHaveBeenCalled()
  })

  it('uses the current checker state for two wire callbacks with the same stale done operation', async () => {
    const t = fixture(), [todo] = t.seed(1, { space: t.dm })
    const initialCard = t.host.todoCard([todo!], 0, undefined, 0, { kind: 'create', receiveId: t.dm.chatId! })
    const value = callbacks(initialCard, 'todo')[0]!, proof = t.todos.getProvenance(todo!.id)
    expect(value.op).toBe('done')
    for (const checked of [true, false]) {
      // Feishu reuses the original card's custom value; only action.checked
      // describes this interaction. Do not synthesize a new op from the UI.
      const wire = { context: { open_chat_id: t.dm.chatId!, open_message_id: 'synthetic-checker-card' },
        operator: { open_id: 'alice' }, action: { tag: 'checker', checked, value } }
      expect(wire.action.value.op).toBe('done')
      const result = await t.host.handleCardAction(normalizeCardAction(wire))
      expect(result).toMatchObject({ toast: { type: 'success' } })
      expect(t.todos.get(todo!.id)).toMatchObject({ id: todo!.id, status: checked ? 'done' : 'open',
        title: todo!.title, detail: todo!.detail, createdAt: todo!.createdAt })
      expect(checkers(returnedCard(result)).find(node => callbacks(node, 'todo')[0]?.id === todo!.id)?.checked).toBe(checked)
      expect(t.todos.getProvenance(todo!.id)).toEqual(proof)
    }
    expect(t.todos.count(spaceScope(t.dm.id), { status: 'all' })).toBe(1)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })

  it('filters other DM IDs and known foreign session origins before rendering any page', async () => {
    const t = fixture(), own = t.seed(4, { space: t.dm }), foreign = t.seed(2, { space: t.otherDm, owner: 'bob', titlePrefix: 'OTHER_DM_PRIVATE_CANARY' })
    // The source session overrides an incorrectly shared/legacy scope; content does not become local merely by carrying it.
    const misplaced = t.todos.add({ scope: spaceScope(t.dm.id), sessionKey: foreign[0]!.sessionKey!,
      title: 'FOREIGN_SOURCE_PRIVATE_CANARY', detail: 'FOREIGN_SOURCE_DETAIL_CANARY', createdBy: 'bob' })
    const ids = [...own, ...foreign, misplaced].map(item => item.id), before = t.snapshot()
    const card = returnedCard(await t.host.handleCardAction(action({ action: 'todo_page', page: 0, ids,
      scope: spaceScope(t.otherDm.id), operatorOpenId: 'bob' }, t.dm.chatId!)))
    const rendered = JSON.stringify(card)
    expect(rendered).not.toContain('OTHER_DM_PRIVATE_CANARY')
    expect(rendered).not.toContain('FOREIGN_SOURCE_PRIVATE_CANARY')
    expect(callbacks(card, 'todo').map(value => value.id)).toEqual(own.map(item => item.id))
    expect(t.snapshot()).toEqual(before)
    const rejected = await t.host.handleCardAction(action({ action: 'todo', id: misplaced.id, op: 'done', ids, page: 0 }, t.dm.chatId!))
    expect(rejected).toMatchObject({ toast: { type: 'error' } })
    expect(JSON.stringify(rejected)).not.toMatch(/OTHER_DM_PRIVATE_CANARY|FOREIGN_SOURCE_PRIVATE_CANARY/)
    expect(t.snapshot()).toEqual(before)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })

  it.each(['todo_page', 'todo'] as const)('rejects another actor in a DM even for legacy Todo rows without a session (%s)', async kind => {
    const t = fixture(), legacy = t.todos.add({ scope: spaceScope(t.dm.id), title: 'ALICE_LEGACY_PRIVATE_CANARY', createdBy: 'alice' })
    const before = t.snapshot()
    const result = await t.host.handleCardAction(action({ action: kind, id: legacy.id, ids: [legacy.id], page: 0,
      op: 'done', operatorOpenId: 'alice' }, t.dm.chatId!, 'bob'))
    expect(result).toMatchObject({ toast: { type: 'error' } })
    expect(t.snapshot()).toEqual(before)
    expect(JSON.stringify(result)).not.toContain(legacy.title)
    expect(JSON.stringify(t.fake.sent)).not.toContain(legacy.title)
  })

  it.each(['todo_page', 'todo'] as const)('keeps stopped space cards inert (%s)', async kind => {
    const t = fixture(), [todo] = t.seed(1), before = t.snapshot()
    t.spaces.suspend(t.group.id)
    const result = await t.host.handleCardAction(action({ action: kind, id: todo!.id, op: 'done', ids: [todo!.id], page: 0 }))
    expect(result).toMatchObject({ toast: { type: 'error' } })
    expect(t.fake.of('patchCard')).toHaveLength(0)
    expect(t.snapshot()).toEqual(before)
  })

  it('admits a first real group member from a fresh membership lookup without changing any Todo on page navigation', async () => {
    const t = fixture(), items = t.seed(45), before = t.snapshot()
    t.fake.members.get(t.group.chatId!)!.add('first-member')
    expect(t.spaces.roleOf(t.group.id, 'first-member')).toBeUndefined()
    const lookup = vi.spyOn(t.fake, 'chatMemberOpenIds')
    const card = t.host.todoCard(items, 0, undefined, 0, { kind: 'create', receiveId: t.group.chatId! })
    const page = returnedCard(await t.host.handleCardAction(action(next(card)!, t.group.chatId!, 'first-member')))
    expect(lookup).toHaveBeenCalledWith(t.group.chatId, { fresh: true })
    expect(t.spaces.roleOf(t.group.id, 'first-member')).toBe('member')
    expect(t.snapshot()).toEqual(before)
    expect(callbacks(page, 'todo')[0]!.page).toBe(1)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })

  it('reports group membership lookup failure without requesting personal OAuth or changing business state', async () => {
    const t = fixture(), items = t.seed(2), before = t.snapshot()
    vi.spyOn(t.fake, 'chatMemberOpenIds').mockRejectedValueOnce(new Error('synthetic network outage'))
    const result = await t.host.handleCardAction(action({ action: 'todo_page', ids: items.map(item => item.id), page: 0 }))
    expect(result).toMatchObject({ toast: { type: 'error', content: '暂时无法核验群成员，请稍后重试。' } })
    expect(JSON.stringify(result)).not.toMatch(/OAuth|个人授权|连接授权|synthetic network outage/)
    expect(t.fake.sent).toEqual([])
    expect(t.snapshot()).toEqual(before)
  })

  it.each(['membership', 'space'] as const)('does not revive a group authorization revoked during the lookup (%s)', async boundary => {
    const t = fixture(), [todo] = t.seed(1), before = t.snapshot(), entered = deferred(), release = deferred()
    vi.spyOn(t.fake, 'chatMemberOpenIds').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise
      return new Set(['alice', 'bob'])
    })
    const pending = t.host.handleCardAction(action({ action: 'todo', id: todo!.id, op: 'done', ids: [todo!.id], page: 0 }, t.group.chatId!, 'bob'))
    await entered.promise
    if (boundary === 'membership') t.spaces.removeMember(t.group.id, 'bob')
    else t.spaces.suspend(t.group.id)
    release.resolve()
    expect(await pending).toMatchObject({ toast: { type: 'error' } })
    expect(t.fake.of('patchCard')).toHaveLength(0)
    expect(t.snapshot()).toEqual(before)
    if (boundary === 'membership') expect(t.spaces.roleOf(t.group.id, 'bob')).toBeUndefined()
    else expect(t.spaces.get(t.group.id)?.status).toBe('archived')
  })

  it('rejects a DM checkbox when the space is suspended during the async audience lease handoff', async () => {
    const t = fixture(), [todo] = t.seed(1, { space: t.dm }), before = t.snapshot()
    // The DM branch has no provider lookup, but returning its async lease still
    // yields before the caller can mutate the Todo. Revocation wins in that gap.
    const pending = t.host.handleCardAction(action({ action: 'todo', id: todo!.id, op: 'done', ids: [todo!.id], page: 0 }, t.dm.chatId!))
    t.spaces.suspend(t.dm.id)
    expect(await pending).toMatchObject({ toast: { type: 'error' } })
    expect(t.snapshot()).toEqual(before)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })

  it('delivers every long-answer part before a separately paged list, with distinct final delivery keys', async () => {
    const t = fixture(), items = t.seed(27, { sources: 14 })
    const answer = Array.from({ length: 700 }, (_, index) => `合成长正文第 ${index} 段：${'完整材料'.repeat(10)}`).join('\n')
    expect(shouldFold(answer)).toBe(false)
    const expectedParts = chunkMarkdown(answer)
    expect(expectedParts.length).toBeGreaterThan(1)
    t.execution.peer.state.script = [{ kind: 'hook', run: () => {
      const servers = t.execution.peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = t.tokens.verify(servers[0]!.env.find(value => value.name === 'FRIDAY_CAP_TOKEN')!.value)!
      t.host.abilities.notedTodos(cap, items.map(item => item.id))
    } }, { kind: 'text', text: answer }]
    const message: InboundMessage = { eventId: 'synthetic-long-answer', messageId: 'synthetic-long-answer', chatId: t.group.chatId!,
      chatType: 'group', msgType: 'text', text: '列出这些事项及完整说明。', senderOpenId: 'alice', senderType: 'user',
      mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }], createTimeMs: Date.now(), tenantId: 'synthetic-tenant' }
    await t.host.handleMessage(message)
    expect(t.fake.of('replyMarkdown').map(sent => sent.payload)).toEqual(expectedParts)
    const listSent = t.fake.of('replyCard').at(-1)!, list = listSent.payload as Card
    expect(next(list)).toBeDefined()
    expect(callbacks(list, 'todo')[0]!.ids).toEqual(items.map(item => item.id))
    const task = t.registry.taskForMessage(message.messageId)!
    const receipts = t.registry.db.prepare('SELECT delivery_key,status,remote_id FROM deliveries WHERE delivery_key LIKE ? ORDER BY created_at').all(`task:${task.id}:final:%`)
    expect(receipts).toHaveLength(expectedParts.length + 1)
    expect(new Set(receipts.map(receipt => receipt.delivery_key)).size).toBe(receipts.length)
    expect(receipts.every(receipt => receipt.status === 'sent' && receipt.remote_id)).toBe(true)
    expect(receipts.at(-1)!.delivery_key).toBe(`task:${task.id}:final:${expectedParts.length}`)
    expect(t.todos.count(spaceScope(t.group.id), { status: 'all' })).toBe(items.length)
    const expectedUrls = new Set(items.flatMap(item => [item.origin!.request!, ...item.origin!.selectedInputs]
      .flatMap(source => source.link.status === 'available' ? [source.link.url] : [])))
    const foundUrls = new Set<string>()
    let page = list, pageCount = 0
    for (;;) {
      expect(measureTodoCard(page, { kind: 'create', receiveId: t.group.chatId! }).fits).toBe(true)
      for (const node of nodes(page).filter(node => node.tag === 'markdown' && typeof node.content === 'string')) {
        for (const match of (node.content as string).matchAll(/\]\((https:[^)]+)\)/g)) foundUrls.add(match[1]!)
      }
      const destination = next(page)
      if (!destination) break
      expect(++pageCount).toBeLessThan(30)
      page = returnedCard(await t.host.handleCardAction(action(destination, t.group.chatId!, 'alice', listSent.messageId)))
    }
    expect(foundUrls).toEqual(expectedUrls)
    expect(t.fake.of('patchCard')).toHaveLength(0)
  })
})
