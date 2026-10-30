import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { Bugs } from '../src/core/bugs.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import { FeishuMinutes, MINUTES_SCOPES, type MinutesClient } from '../src/feishu/minutes.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { normalizeCardAction } from '../src/feishu/ws.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient, type SentRecord } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

type Api = MinutesClient['minutes']['v1']['minute']
type Tools = { text(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }> }
const MINUTE_URL = 'https://synthetic.feishu.cn/minutes/minute_a'
const CREATED = Date.parse('2026-09-24T02:00:00Z')
const HOURS_72 = 72 * 3600_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const cardText = (item: SentRecord) => JSON.stringify(item.payload)

/** Production assembly as in index.ts. Only the model (ACP peer), Feishu IM/OAuth and the Minutes SDK responses are synthetic. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-minutes-todos-flow-')), registry = new Registry(join(home, 'db'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true',
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '20000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'owner' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('minutes-todos-flow-test', 'error')
  fake.members.set(group.chatId!, new Set(['owner', 'alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), bugs = new Bugs(registry.db), tokens = new TokenIssuer('synthetic-minutes-todos-key')
  const sdk = {
    search: vi.fn<Api['search']>().mockResolvedValue({ code: 0, data: { items: [{ token: 'minute_a' }], has_more: false } }),
    get: vi.fn<Api['get']>().mockResolvedValue({ code: 0, data: { minute: { token: 'minute_a', title: '周会纪要', url: MINUTE_URL, create_time: String(CREATED) } } }),
    artifacts: vi.fn<Api['artifacts']>().mockResolvedValue({ code: 0, data: { summary: 'PRIVATE_SUMMARY', minute_todos: [
      { content: '整理发布清单', assignees: ['alice'], is_done: false }, { content: '跟进接口变更', assignees: ['ou_bob'], is_done: false },
      { content: '补充验收用例' }, { content: '已完成的旧事项', assignees: ['alice'], is_done: true }] } }),
  }
  const minutes = new FeishuMinutes({ minutes: { v1: { minute: sdk } } })
  // Alice's real personal grant covers the three Minutes scopes; her identity check returns her own open_id.
  fake.nextToken = { accessToken: 'uat-alice', expiresIn: 7200, refreshToken: 'rt-alice', refreshTokenExpiresIn: 30 * 86400, scope: Object.values(MINUTES_SCOPES).join(' ') }
  fake.identities.set('uat-alice', { openId: 'alice', name: 'Alice', tenantKey: 'synthetic-tenant' })
  const userTokens = new UserTokenStore(registry.db, fake)
  await userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: cfg.feishu.oauth.redirectUri })
  const clock = { offset: 0 }, execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, userTokens, feishu, minutes,
    runtime: execution.runtime, managed: execution.managed, tokens, botOpenId: 'bot', log, now: () => Date.now() + clock.offset,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const server = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu, minutes,
    tokens, bugs, abilities: host.abilities, log, maxHistoryPerCall: 20, oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    get minutesTodos() { return host.minutesTodos },
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    onExternalSourceRead: (key, read) => host.noteExternalSource(key, read),
    canPersistDerivedState: key => host.canPersistDerivedState(key), isManagedRun: id => host.isManagedRun(id),
    captureTodoProvenance: (key, id) => host.captureTodoProvenance(key, id) })
  await new Promise<void>(done => server.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`, state = execution.peer.state
  cleanups.push(async () => {
    server.beginShutdown(); host.beginShutdown(); await execution.runtime.stop(); server.server.closeAllConnections()
    await new Promise<void>(done => server.server.close(() => done()))
    expect(await server.waitForShutdown(1000)).toMatchObject({ drained: true }); expect(await host.waitForShutdown(1000)).toMatchObject({ drained: true })
    registry.close(); rmSync(home, { recursive: true, force: true })
  })
  const token = () => {
    const servers = state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
    return servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value
  }
  const tools = async (): Promise<Tools & { close(): Promise<void> }> => {
    const mcp = buildServer({ apiUrl: base, token: token() }), client = new Client({ name: 'synthetic-minutes-model', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(b); await client.connect(a)
    return { close: async () => { await client.close(); await mcp.close() },
      text: async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args })
        return { isError: result.isError === true, text: (result.content as { text: string }[]).map(item => item.text).join('\n') }
      } }
  }
  /** The synthetic model of the next Run calls tools with the token its own Run was issued. */
  const request = async (id: string, where: 'dm' | 'group', sender: string, hook: (mcp: Tools) => Promise<void>) => {
    state.script = [{ kind: 'hook', run: async () => {
      const mcp = await tools()
      try { await hook(mcp) } finally { await mcp.close() }
    } }, { kind: 'text', text: '已处理。' }]
    const inGroup = where === 'group'
    const message: InboundMessage = { eventId: id, messageId: id, chatId: inGroup ? group.chatId! : dm.chatId!, chatType: inGroup ? 'group' : 'p2p',
      senderOpenId: sender, senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text', text: inGroup ? '@Friday 把这份妙记里我负责的行动项记成待办。' : '把这份妙记里我负责的行动项记成待办。',
      mentions: inGroup ? [{ key: '@Friday', openId: 'bot', name: 'Friday' }] : [], createTimeMs: Date.now() }
    await host.handleMessage(message)
    expect(registry.taskForMessage(id)?.status).toBe('done')
  }
  const draftCards = () => fake.sent.filter(item => item.kind === 'sendToUser' && cardText(item).includes('minutes_draft_decide'))
  const decide = (card: SentRecord, operator: string, decision: 'accept' | 'ignore', where: { messageId?: string; chatId?: string } = {}) =>
    host.handleCardAction(normalizeCardAction({ operator: { open_id: operator },
      context: { open_chat_id: where.chatId ?? dm.chatId!, open_message_id: where.messageId ?? card.messageId },
      action: { tag: 'button', value: { action: 'minutes_draft_decide', draftId: /"draftId":"([^"]+)"/.exec(cardText(card))![1],
        digest: /"digest":"([^"]+)"/.exec(cardText(card))![1], decision } } })) as Promise<Record<string, any>>
  /** A checker click on the delivered card, as the platform sends it: the resulting state comes separately from the static value. */
  const tick = (card: SentRecord, operator: string, item: number, checked = true) =>
    host.handleCardAction(normalizeCardAction({ operator: { open_id: operator }, context: { open_chat_id: dm.chatId!, open_message_id: card.messageId },
      action: { tag: 'checker', checked, value: { action: 'minutes_draft_select', draftId: /"draftId":"([^"]+)"/.exec(cardText(card))![1],
        digest: /"digest":"([^"]+)"/.exec(cardText(card))![1], item } } })) as Promise<Record<string, any>>
  const dmTodos = () => todos.list(spaceScope(dm.id), { status: 'all' }).sort((a, b) => a.id - b.id)
  const drafts = () => registry.db.prepare('SELECT state FROM minutes_drafts ORDER BY created_at').all().map(row => row.state)
  const dmTexts = () => fake.sent.filter(item => item.kind === 'sendToUser' && item.target === 'alice' && 'text' in (item.payload as object))
    .map(item => (item.payload as { text: string }).text).join('\n')
  return { cfg, registry, ...sp, dm, group, fake, sdk, todos, host, clock, request, draftCards, decide, tick, dmTodos, drafts, dmTexts, userTokens }
}

describe('minutes action items reach Todos only through the owner’s card decision', () => {
  it('keeps friday_todo_add refused after a minutes read in the same run (existing source gate, unchanged)', async () => {
    const t = await fixture()
    let read = { isError: true, text: '' }, add = { isError: false, text: '' }
    await t.request('dm-read-then-add', 'dm', 'alice', async mcp => {
      read = await mcp.text('feishu_minute_todos', { minute_token: 'minute_a' })
      add = await mcp.text('friday_todo_add', { title: '整理发布清单' })
    })
    expect(read.isError, read.text).toBe(false)
    expect(JSON.parse(read.text).todos).toHaveLength(4)
    expect(add).toMatchObject({ isError: true, text: expect.stringContaining('这一轮已经读过别的群') })
    expect(t.dmTodos()).toEqual([])
  })

  it('shows the items with tick boxes to the owner, writes nothing before acceptance, and records the ticked ones with the minute as origin', async () => {
    const t = await fixture()
    let proposed = { isError: true, text: '' }, add = { isError: false, text: '' }
    await t.request('dm-propose', 'dm', 'alice', async mcp => {
      await mcp.text('feishu_minute_todos', { minute_token: 'minute_a' })
      proposed = await mcp.text('feishu_propose_minute_todos', { minute_token: 'minute_a', items: [0, 1, 2] })
      // The proposal does not open the gate: the model still cannot write the Todo itself.
      add = await mcp.text('friday_todo_add', { title: '绕过本人确认直接记待办' })
    })
    expect(proposed.isError, proposed.text).toBe(false)
    expect(JSON.parse(proposed.text)).toMatchObject({ state: 'pending', reviewDelivered: true, items: 3 })
    expect(add).toMatchObject({ isError: true, text: expect.stringContaining('这一轮已经读过别的群') })
    expect(t.dmTodos()).toEqual([])
    expect(t.dmTexts()).not.toContain('整理发布清单')
    const [card] = t.draftCards()
    expect(card?.target).toBe('alice')
    const shown = cardText(card!)
    for (const value of ['妙记「周会纪要」 · 9月24日', MINUTE_URL, '整理发布清单', '跟进接口变更', '补充验收用例']) expect(shown).toContain(value)
    expect(shown).not.toContain('已完成的旧事项'); expect(shown).not.toContain('PRIVATE_SUMMARY')
    // Someone else's tick is refused and redraws nothing of the owner's; the owner's ticks redraw the card from the stored state.
    expect(await t.tick(card!, 'bob', 1)).toMatchObject({ toast: { type: 'error' } })
    expect(JSON.stringify(await t.tick(card!, 'bob', 1))).not.toContain('整理发布清单')
    expect(JSON.stringify((await t.tick(card!, 'alice', 1)).card)).toContain('记录勾选的 2 项')
    expect(JSON.stringify((await t.tick(card!, 'alice', 2)).card)).toContain('记录勾选的 3 项')
    // Nobody else, no forwarded copy and no other chat can decide; nothing is written or re-read.
    const reads = t.sdk.artifacts.mock.calls.length
    expect(await t.decide(card!, 'bob', 'accept')).toMatchObject({ toast: { type: 'error' } })
    expect(await t.decide(card!, 'alice', 'accept', { messageId: 'om_forwarded_copy' })).toMatchObject({ toast: { type: 'error' } })
    expect(await t.decide(card!, 'alice', 'accept', { chatId: t.group.chatId! })).toMatchObject({ toast: { type: 'error' } })
    expect(t.dmTodos()).toEqual([])
    expect(t.sdk.artifacts.mock.calls.length).toBe(reads)
    // The owner's acceptance is a separate host operation: it re-reads the minute with her current grant and writes all three.
    const accepted = await t.decide(card!, 'alice', 'accept')
    expect(accepted.toast).toEqual({ type: 'success', content: '已记录 3 项待办。' })
    expect(accepted.card).toMatchObject({ type: 'raw', data: { header: { title: { content: '已记录' } } } })
    expect(JSON.stringify(accepted.card)).not.toContain('minutes_draft_decide')
    expect(t.sdk.artifacts.mock.calls.length).toBe(reads + 1)
    const items = t.dmTodos()
    expect(items.map(item => [item.title, item.confirmed])).toEqual([['整理发布清单', true], ['跟进接口变更', true], ['补充验收用例', true]])
    for (const [index, item] of items.entries()) {
      const provenance = t.todos.getProvenance(item.id)!
      expect(provenance.minutes).toMatchObject({ token: 'minute_a', title: '周会纪要', item: index, link: { status: 'available', url: MINUTE_URL } })
      expect(provenance.request).toMatchObject({ messageId: 'dm-propose', senderOpenId: 'alice', chatId: t.dm.chatId })
      expect(provenance.contextSnapshot.external.map(source => source.kind)).toContain('minutes')
      expect(item.origin?.minutes).toMatchObject({ kind: 'minutes', label: '妙记：周会纪要（2026-09-24）' })
    }
    // Clicking again changes nothing.
    expect((await t.decide(card!, 'alice', 'accept')).toast).toEqual({ type: 'success', content: '已记录 3 项待办。' })
    expect(t.dmTodos()).toHaveLength(3)
    // A later request lists the Todos with the minute as a clickable origin.
    let listed = { isError: true, text: '' }
    await t.request('dm-list', 'dm', 'alice', async mcp => { listed = await mcp.text('friday_todo_list', {}) })
    expect(listed.isError, listed.text).toBe(false)
    expect(listed.text).toContain(`[妙记：周会纪要（2026-09-24）](<${MINUTE_URL}>)`)
  })

  it('discards an ignored draft and expires an unanswered one after 72 hours, writing no Todo in either case', async () => {
    const t = await fixture()
    await t.request('dm-ignore', 'dm', 'alice', async mcp => {
      expect((await mcp.text('feishu_propose_minute_todos', { minute_token: 'minute_a', items: [0] })).isError).toBe(false)
    })
    const [first] = t.draftCards()
    const ignored = await t.decide(first!, 'alice', 'ignore')
    expect(ignored.toast).toEqual({ type: 'info', content: '好的，都不记。' })
    expect(JSON.stringify(ignored.card)).not.toContain('minutes_draft_decide')
    expect((await t.decide(first!, 'alice', 'accept')).toast).toEqual({ type: 'info', content: '好的，都不记。' })
    await t.request('dm-expire', 'dm', 'alice', async mcp => {
      expect((await mcp.text('feishu_propose_minute_todos', { minute_token: 'minute_a', items: [2] })).isError).toBe(false)
    })
    const second = t.draftCards()[1]!
    expect(t.host.expireMinutesDrafts()).toBe(0)
    t.clock.offset += HOURS_72
    expect(t.host.expireMinutesDrafts()).toBe(1)
    const expired = await t.decide(second, 'alice', 'accept')
    expect(expired.toast).toMatchObject({ type: 'info', content: expect.stringContaining('72 小时') })
    expect(t.drafts()).toEqual(['ignored', 'expired'])
    expect(t.dmTodos()).toEqual([])
    const stored = JSON.stringify(t.registry.db.prepare('SELECT value_json FROM minutes_drafts').all())
    for (const value of ['整理发布清单', '补充验收用例', '周会纪要', MINUTE_URL]) expect(stored).not.toContain(value)
  })

  it('refuses to draft from a group, before reading the minute or sending anything', async () => {
    const t = await fixture()
    let result = { isError: false, text: '' }
    await t.request('group-propose', 'group', 'alice', async mcp => {
      result = await mcp.text('feishu_propose_minute_todos', { minute_token: 'minute_a', items: [0] })
    })
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('私聊') })
    expect(t.sdk.get).not.toHaveBeenCalled(); expect(t.sdk.artifacts).not.toHaveBeenCalled()
    expect(t.draftCards()).toEqual([])
    expect(t.drafts()).toEqual([])
  })

  it('rejects the acceptance without writing when the owner lost access to the minute or disconnected her personal grant', async () => {
    const t = await fixture()
    await t.request('dm-revoked', 'dm', 'alice', async mcp => {
      expect((await mcp.text('feishu_propose_minute_todos', { minute_token: 'minute_a', items: [0, 2] })).isError).toBe(false)
    })
    const [card] = t.draftCards()
    // Feishu refuses the re-read at acceptance (resource permission removed): no Todo, no provider text in the reply.
    t.sdk.artifacts.mockResolvedValueOnce({ code: 2091005, msg: 'PRIVATE_PROVIDER_MESSAGE' })
    const refused = await t.decide(card!, 'alice', 'accept')
    expect(refused).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('授权') } })
    expect(JSON.stringify(refused)).not.toContain('PRIVATE_PROVIDER_MESSAGE')
    expect(t.dmTodos()).toEqual([])
    t.userTokens.disconnect('alice')
    expect(await t.decide(card!, 'alice', 'accept')).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('授权') } })
    expect(t.dmTodos()).toEqual([])
    expect(t.drafts()).toEqual(['pending'])
  })
})
