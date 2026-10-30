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
import { MeetingSessions } from '../src/core/meeting-sessions.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { spaceScope } from '../src/core/space.js'
import { Todos } from '../src/core/todos.js'
import { FeishuMeetings, type MeetingsClient } from '../src/feishu/meetings.js'
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

const MEETING_TOOLS = ['friday_join_meeting', 'friday_leave_meeting', 'friday_list_meetings', 'friday_propose_meeting_draft', 'friday_read_meeting', 'friday_sync_meeting']
const CLOSED = '会议旁听没有开启'
type Api = MeetingsClient['vc']['bot']
type Tools = { names(): Promise<string[]>; text(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }> }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function waitFor<T>(read: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, 20))
  }
}
const cardText = (item: SentRecord) => JSON.stringify(item.payload)

/** Production assembly as in index.ts: the meeting tables always exist; with FRIDAY_MEETINGS=off the Orchestrator gets no meeting
 * platform or runtime and the API mounts no meeting route. Only the model (ACP peer), Feishu IM and the VC SDK responses are synthetic. */
async function fixture(deployment: 'on' | 'off') {
  const home = mkdtempSync(join(tmpdir(), 'friday-meeting-switch-')), registry = new Registry(join(home, 'db'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home, FRIDAY_PUBLIC_MODE: 'true',
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '20000', FRIDAY_TRUSTED_USERS: 'carol', FRIDAY_MEETINGS: deployment })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const sp = spaceDeps(registry.db)
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'synthetic-group', openId: 'owner' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), log = createLogger('meeting-switch-test', 'error')
  fake.members.set(group.chatId!, new Set(['owner', 'alice']))
  const memory = new ChannelMemory(registry.db), cache = new MessageCache(registry.db), messages = new MessageService(feishu, cache, log)
  const todos = new Todos(registry.db), bugs = new Bugs(registry.db), tokens = new TokenIssuer('synthetic-meeting-switch-key')
  const api = { join: vi.fn<Api['join']>().mockResolvedValue({ code: 0, data: { meeting: { id: 'meeting-1', meeting_no: '123456789', topic: 'Synthetic review' }, join_user: { id: 'bot-participant' } } }),
    leave: vi.fn<Api['leave']>().mockResolvedValue({ code: 0, data: { leave_user: { id: 'bot-participant' } } }),
    userActiveMeeting: vi.fn<Api['userActiveMeeting']>().mockResolvedValue({ code: 0, data: { meetings: [] } }),
    events: vi.fn<Api['events']>().mockResolvedValue({ code: 0, data: { events: [], has_more: false } }) }
  const sessions = new MeetingSessions(registry.db)
  const meetings = cfg.meetings.enabled ? { sessions, provider: new FeishuMeetings({ vc: { bot: api } }) } : undefined
  const userTokens = new UserTokenStore(registry.db, fake), execution = managedHostRuntime(registry, home, log)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, messages, userTokens, feishu,
    runtime: execution.runtime, managed: execution.managed, tokens, meetings, botOpenId: 'bot', log,
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', ingressClassifier: { classify: async () => ({ kind: 'new_work' }) } })
  const server = createInternalApi({ appId: cfg.feishu.appId, registry, ...sp, memory, todos, messages, messageCache: cache, userTokens, feishu,
    tokens, bugs, meetingsEnabled: cfg.meetings.enabled, get meetings() { return host.meetings?.application }, abilities: host.abilities, log, maxHistoryPerCall: 20,
    oauthRedirectUri: cfg.feishu.oauth.redirectUri,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: (key, purpose) => host.canPersistDerivedState(key, purpose), isManagedRun: id => host.isManagedRun(id),
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
    const mcp = buildServer({ apiUrl: base, token: token() }), client = new Client({ name: 'synthetic-meeting-switch-model', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(b); await client.connect(a)
    return { close: async () => { await client.close(); await mcp.close() },
      names: async () => (await client.listTools()).tools.map(item => item.name).filter(name => MEETING_TOOLS.includes(name)).sort(),
      text: async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args })
        return { isError: result.isError === true, text: (result.content as { text: string }[]).map(item => item.text).join('\n') }
      } }
  }
  /** The synthetic model of the next Run (a user request or a host event) runs `hook` with the tools its own Run token lists. */
  const script = (hook: (mcp: Tools) => Promise<void>, answer = '已处理。') => {
    state.script = [{ kind: 'hook', run: async () => {
      const mcp = await tools()
      try { await hook(mcp) } finally { await mcp.close() }
    } }, { kind: 'text', text: answer }]
  }
  const request = async (id: string, where: 'dm' | 'group', sender: string, hook: (mcp: Tools) => Promise<void>, status = 'done') => {
    script(hook)
    const inGroup = where === 'group'
    const message: InboundMessage = { eventId: id, messageId: id, chatId: inGroup ? group.chatId! : dm.chatId!, chatType: inGroup ? 'group' : 'p2p',
      senderOpenId: sender, senderType: 'user', tenantId: 'synthetic-tenant', msgType: 'text', text: inGroup ? '@Friday 合成请求。' : '合成请求。',
      mentions: inGroup ? [{ key: '@Friday', openId: 'bot', name: 'Friday' }] : [], createTimeMs: Date.now() }
    await host.handleMessage(message)
    expect(registry.taskForMessage(id)?.status).toBe(status)
  }
  const scopes = () => tokens.verify(token())!.scopes.filter(scope => scope.startsWith('meetings:'))
  const approvalCards = () => fake.sent.filter(item => item.kind === 'sendToUser' && cardText(item).includes('"action":"perm"'))
  const perm = (card: SentRecord, operator: string, decision: 'allow' | 'deny', where: { messageId?: string; chatId?: string } = {}) =>
    host.handleCardAction(normalizeCardAction({ operator: { open_id: operator },
      context: { open_chat_id: where.chatId ?? dm.chatId!, open_message_id: where.messageId ?? card.messageId },
      action: { tag: 'button', value: { action: 'perm', request_id: /"request_id":"([^"]+)"/.exec(cardText(card))![1], decision } } }))
  const draftCard = () => fake.sent.find(item => item.kind === 'sendToUser' && cardText(item).includes('meeting_draft_decide'))
  const decide = (card: SentRecord, operator: string, decision: 'accept' | 'reject') => host.handleCardAction(normalizeCardAction({ operator: { open_id: operator },
    context: { open_chat_id: dm.chatId!, open_message_id: card.messageId }, action: { tag: 'button', value: { action: 'meeting_draft_decide',
      draftId: /"draftId":"([^"]+)"/.exec(cardText(card))![1], digest: /"digest":"([^"]+)"/.exec(cardText(card))![1], decision } } }))
  return { cfg, registry, ...sp, dm, group, fake, api, sessions, todos, host, base, request, script, scopes, approvalCards, perm, draftCard, decide }
}

describe('meeting attendance is off by default (FRIDAY_MEETINGS deployment switch and per-space switches)', () => {
  it('reads FRIDAY_MEETINGS as off unless it is exactly on', () => {
    const env = { FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret' }
    expect(loadConfig(env).meetings.enabled).toBe(false)
    expect(loadConfig({ ...env, FRIDAY_MEETINGS: 'off' }).meetings.enabled).toBe(false)
    expect(loadConfig({ ...env, FRIDAY_MEETINGS: 'on' }).meetings.enabled).toBe(true)
    expect(() => loadConfig({ ...env, FRIDAY_MEETINGS: 'true' })).toThrow('FRIDAY_MEETINGS')
  })

  it('issues meeting scopes and tools only when the request space and the requester’s own private chat are both turned on', async () => {
    const t = await fixture('on')
    expect(t.spaces.get(t.dm.id)?.config.meetings).toBeUndefined()
    let reply = ''
    await t.request('dm-default', 'dm', 'alice', async mcp => {
      expect(await mcp.names()).toEqual([])
      reply = (await mcp.text('friday_space_settings', { args: 'set meetings on' })).text
    })
    expect(t.scopes()).toEqual([])
    expect(reply).toContain('已在你的私聊开启会议旁听')
    expect(t.spaces.get(t.dm.id)?.config.meetings).toBe('on')
    await t.request('dm-on', 'dm', 'alice', async mcp => { expect(await mcp.names()).toEqual(MEETING_TOOLS) })
    expect(t.scopes()).toEqual(['meetings:read', 'meetings:write'])
    // Turning it off applies at once, even inside a Run whose token was issued while it was on.
    let listed = { isError: false, text: '' }
    await t.request('dm-off-in-run', 'dm', 'alice', async mcp => {
      expect(await mcp.names()).toEqual(MEETING_TOOLS)
      reply = (await mcp.text('friday_space_settings', { args: 'set meetings off' })).text
      listed = await mcp.text('friday_list_meetings')
    })
    expect(reply).toContain('已关闭你私聊里的会议旁听')
    expect(listed).toMatchObject({ isError: true, text: expect.stringContaining(CLOSED) })
    t.spaces.patchConfig(t.dm.id, { meetings: 'on' })
    // A group needs its own owner's decision; a member cannot switch it on.
    let denied = { isError: false, text: '' }
    await t.request('group-default', 'group', 'alice', async mcp => {
      expect(await mcp.names()).toEqual([])
      denied = await mcp.text('friday_space_settings', { args: 'set meetings on' })
    })
    expect(denied.isError).toBe(true)
    expect(t.spaces.get(t.group.id)?.config.meetings).toBeUndefined()
    await t.request('group-enable', 'group', 'owner', async mcp => { reply = (await mcp.text('friday_space_settings', { args: 'set meetings on' })).text })
    expect(reply).toContain('本群已开启会议旁听')
    await t.request('group-on', 'group', 'alice', async mcp => { expect(await mcp.names()).toEqual(MEETING_TOOLS) })
    // The group owner has not turned meetings on in their own private chat, so their group requests get no meeting tools.
    await t.request('group-owner', 'group', 'owner', async mcp => { expect(await mcp.names()).toEqual([]) })
    expect(t.scopes()).toEqual([])
    // Turning the private switch off also closes this person's group requests.
    await t.request('dm-disable', 'dm', 'alice', async mcp => { reply = (await mcp.text('friday_space_settings', { args: 'set meetings off' })).text })
    expect(reply).toContain('已关闭你私聊里的会议旁听')
    await t.request('group-after-dm-off', 'group', 'alice', async mcp => { expect(await mcp.names()).toEqual([]) })
    expect(t.scopes()).toEqual([])
  })

  it('joins only after the requester clicks the original private card, then reviews ended events before any Todo, and stops while turned off', async () => {
    const t = await fixture('on')
    t.spaces.patchConfig(t.dm.id, { meetings: 'on' })
    let joined = { isError: true, text: '' }, duplicate = { isError: true, text: '' }
    await t.request('join-request', 'dm', 'alice', async mcp => {
      const pending = mcp.text('friday_join_meeting', { meetingNumber: '123456789' })
      const card = await waitFor(() => t.approvalCards()[0], 'join approval card')
      expect(card.target).toBe('alice')
      // A trusted user may approve ordinary confirmations, but not another person's meeting delegation;
      // the requester's click on a forwarded copy or from another chat is refused too.
      expect(await t.perm(card, 'carol', 'allow')).toMatchObject({ toast: { type: 'error' } })
      expect(await t.perm(card, 'alice', 'allow', { messageId: 'om_forwarded_copy' })).toMatchObject({ toast: { type: 'error' } })
      expect(await t.perm(card, 'alice', 'allow', { chatId: t.group.chatId! })).toMatchObject({ toast: { type: 'error' } })
      expect(t.api.join).not.toHaveBeenCalled()
      expect(await t.perm(card, 'alice', 'allow')).toEqual({ toast: { type: 'success', content: '已允许' } })
      joined = await pending
      duplicate = await mcp.text('friday_join_meeting', { meetingNumber: '123456789' })
    })
    expect(joined.isError, joined.text).toBe(false)
    expect(JSON.parse(joined.text)).toMatchObject({ state: 'awaiting_admission', coverage: { confirmedParticipation: false } })
    expect(JSON.parse(duplicate.text).sessionId).toBe(JSON.parse(joined.text).sessionId)
    expect(t.api.join).toHaveBeenCalledTimes(1)
    expect(t.api.join).toHaveBeenCalledWith({ data: { join_type: 1, join_identify: { meeting_no: '123456789' } } })
    expect(t.approvalCards()).toHaveLength(1)
    // Switched off: the lifecycle timer does not contact the platform and the person's requests get no meeting tools.
    t.spaces.patchConfig(t.dm.id, { meetings: 'off' })
    await t.host.meetings!.tick()
    expect(t.api.userActiveMeeting).not.toHaveBeenCalled(); expect(t.api.events).not.toHaveBeenCalled()
    await t.request('while-off', 'dm', 'alice', async mcp => { expect(await mcp.names()).toEqual([]) })
    // Switched on again: the bot's own join event confirms attendance, the end event closes it, and the host queues the review in the same private chat.
    t.spaces.patchConfig(t.dm.id, { meetings: 'on' })
    t.api.events.mockResolvedValue({ code: 0, data: { has_more: false, events: [
      { event_id: 'joined', event_type: 'participant_joined', payload: { participant_joined_items: [{ participant: { id: 'bot-participant' } }] } },
      { event_id: 'speech', event_type: 'transcript_received', payload: { transcript_received_items: [{ speaker: { id: 'alice', user_name: 'Alice' }, text: 'Synthetic follow-up requested.' }] } },
      { event_id: 'ended', event_type: 'participant_left', payload: { participant_left_items: [{ participant: { id: 'bot-participant' }, leave_reason: 2 }] } },
    ] } })
    const draftRun = { read: { isError: true, text: '' }, proposed: { isError: true, text: '' }, todo: { isError: false, text: '' }, memory: { isError: false, text: '' }, hostMemory: '' }
    t.script(async mcp => {
      const sessionId = JSON.parse((await mcp.text('friday_list_meetings')).text).meetings[0].sessionId
      draftRun.read = await mcp.text('friday_read_meeting', { sessionId })
      draftRun.proposed = await mcp.text('friday_propose_meeting_draft', { sessionId, summary: '合成会议的实际转写：需要跟进一个问题。',
        actions: [{ title: '跟进合成问题', ownerOpenId: 'alice' }, { title: '同事确认排期', owner: '同事' }] })
      draftRun.todo = await mcp.text('friday_todo_add', { title: '绕过本人确认直接记待办' })
      draftRun.memory = await mcp.text('friday_memory_save', { title: '会议结论', body: '不能绕过来源核验写进长期记忆' })
      // The host entry behind the memory route refuses meeting material by itself as well.
      const runId = t.host.resolveActorForSession(t.registry.taskForMessage('join-request')!.sessionKey)!.runId
      draftRun.hostMemory = await t.host.addMemory(runId, { scope: spaceScope(t.dm.id), kind: 'fact', title: '会议结论', body: '宿主入口也拒绝' })
        .then(() => 'saved', (error: Error) => error.message)
    }, '纪要和行动项已发给你确认。')
    await t.host.meetings!.tick()
    const eventTask = Number(await waitFor(() => t.registry.db.prepare("SELECT task_id FROM task_event_sources WHERE kind='meeting_draft'").get()?.task_id, 'meeting draft event'))
    await waitFor(() => ['done', 'failed'].includes(t.registry.getTask(eventTask)?.status ?? ''), 'meeting draft run')
    expect(t.registry.getTask(eventTask)).toMatchObject({ status: 'done', requesterOpenId: 'alice', sessionKey: t.registry.taskForMessage('join-request')!.sessionKey })
    const session = t.sessions.list()[0]!
    expect(session).toMatchObject({ state: 'ended', coverageComplete: true, meetingId: 'meeting-1' }); expect(session.confirmedAt).toBeTruthy()
    expect(draftRun.read.isError, draftRun.read.text).toBe(false); expect(JSON.parse(draftRun.read.text)).toMatchObject({ total: 3, nextOffset: null })
    expect(draftRun.proposed.isError, draftRun.proposed.text).toBe(false); expect(JSON.parse(draftRun.proposed.text).reviewDelivered).toBe(true)
    // After reading meeting events the model cannot write a Todo or a long-term memory itself; only the owner's card decision can.
    expect(draftRun.todo).toMatchObject({ isError: true, text: expect.stringContaining('这一轮已经读过别的群') })
    expect(draftRun.memory).toMatchObject({ isError: true, text: expect.stringContaining('这一轮已经读过别的群') })
    expect(draftRun.hostMemory).toBe('会议材料尚未接入长期记忆来源核验')
    expect(t.todos.list(spaceScope(t.dm.id), { status: 'all' })).toEqual([])
    expect(t.fake.answers()).toContain('纪要和行动项已发给你确认。')
    const card = t.draftCard()!
    expect(card.target).toBe('alice')
    expect(t.fake.sent.filter(item => item.kind === 'sendToUser' && JSON.stringify(item.payload).includes('会议纪要待审稿')).map(item => item.target)).toEqual(['alice'])
    // Turned off: the review card is refused with the reason; nothing is written.
    t.spaces.patchConfig(t.dm.id, { meetings: 'off' })
    expect(await t.decide(card, 'alice', 'accept')).toEqual({ toast: { type: 'error', content: expect.stringContaining(CLOSED) } })
    expect(t.todos.list(spaceScope(t.dm.id), { status: 'all' })).toEqual([])
    t.spaces.patchConfig(t.dm.id, { meetings: 'on' })
    expect(await t.decide(card, 'bob', 'accept')).toMatchObject({ toast: { type: 'error' } })
    expect(await t.decide(card, 'alice', 'accept')).toEqual({ toast: { type: 'success', content: '已记录 2 项待办。' } })
    expect(await t.decide(card, 'alice', 'accept')).toEqual({ toast: { type: 'success', content: '已记录 2 项待办。' } })
    const items = t.todos.list(spaceScope(t.dm.id), { status: 'all' }).sort((a, b) => a.id - b.id)
    expect(items.map(item => [item.title, item.confirmed])).toEqual([['跟进合成问题', true], ['同事确认排期', false]])
    expect(items.map(item => t.todos.getProvenance(item.id)?.contextSnapshot.meetingSources?.length)).toEqual([1, 1])
  })

  it('a group request still asks only the requester in their private chat', async () => {
    const t = await fixture('on')
    t.spaces.patchConfig(t.dm.id, { meetings: 'on' }); t.spaces.patchConfig(t.group.id, { meetings: 'on' })
    let result = { isError: false, text: '' }
    await t.request('group-join', 'group', 'alice', async mcp => {
      const pending = mcp.text('friday_join_meeting', { meetingNumber: '987654321' })
      const card = await waitFor(() => t.approvalCards()[0], 'join approval card')
      expect(card.target).toBe('alice')
      expect(await t.perm(card, 'owner', 'allow')).toMatchObject({ toast: { type: 'error' } })
      expect(await t.perm(card, 'alice', 'deny')).toEqual({ toast: { type: 'success', content: '已拒绝' } })
      result = await pending
    })
    expect(result.isError).toBe(true)
    expect(t.fake.sent.filter(item => item.kind !== 'sendToUser' && cardText(item).includes('"action":"perm"'))).toEqual([])
    expect(t.api.join).not.toHaveBeenCalled()
    expect(t.sessions.list()).toEqual([])
  })

  it('with FRIDAY_MEETINGS off, the space switch opens nothing and no meeting route or runtime exists', async () => {
    const t = await fixture('off')
    let reply = ''
    await t.request('enable-request', 'dm', 'alice', async mcp => { reply = (await mcp.text('friday_space_settings', { args: 'set meetings on' })).text })
    expect(reply).toContain('FRIDAY_MEETINGS')
    expect(t.spaces.get(t.dm.id)?.config.meetings).toBe('on')
    await t.request('later-request', 'dm', 'alice', async mcp => { expect(await mcp.names()).toEqual([]) })
    expect(t.scopes()).toEqual([])
    expect(t.host.meetings).toBeUndefined()
    const response = await fetch(`${t.base}/v1/meetings/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(404)
    expect(await t.host.handleCardAction(normalizeCardAction({ operator: { open_id: 'alice' }, context: { open_chat_id: t.dm.chatId!, open_message_id: 'synthetic-card' },
      action: { tag: 'button', value: { action: 'meeting_draft_decide', draftId: 'synthetic-draft', digest: 'a'.repeat(64), decision: 'accept' } } })))
      .toEqual({ toast: { type: 'error', content: '会议旁听当前不可用。' } })
    // The tables exist either way (the migration adapter and startup create them); nothing was written.
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM meeting_sessions').get()?.n).toBe(0)
    expect(t.registry.db.prepare('SELECT count(*) AS n FROM meeting_drafts').get()?.n).toBe(0)
    expect(t.api.join).not.toHaveBeenCalled()
  })
})
