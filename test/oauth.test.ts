import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { UserTokenStore, buildAuthorizeUrl, extractCallback } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, GROUP_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient, cardText, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

describe('oauth helpers', () => {
  it('builds the authorize url with space separated scopes', () => {
    const url = new URL(buildAuthorizeUrl({ appId: 'cli_x', redirectUri: 'http://127.0.0.1:7788/oauth/callback', scopes: ['offline_access', 'im:chat:readonly'], state: 's1' }))
    expect(url.origin + url.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize')
    expect(url.searchParams.get('client_id')).toBe('cli_x')
    expect(url.searchParams.get('scope')).toBe('offline_access im:chat:readonly')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('extracts code and state from a pasted redirect url or a bare code', () => {
    expect(extractCallback('打不开，地址是 http://127.0.0.1:7788/oauth/callback?code=abc123def456&state=st_9 这个')).toEqual({ code: 'abc123def456', state: 'st_9' })
    expect(extractCallback('code=abc123def456')).toEqual({ code: 'abc123def456', state: undefined })
    expect(extractCallback('abcdefghijklmnop1234')).toEqual({ code: 'abcdefghijklmnop1234' })
    expect(extractCallback('今天天气不错')).toBeUndefined()
  })

  it('stores tokens, binds state to the requester, refreshes near expiry and disconnects', async () => {
    let now = 1_000_000
    const feishu = new FakeFeishu()
    const store = new UserTokenStore(new Registry(':memory:').db, feishu, () => now)
    const state = store.begin('ou_a')
    expect(store.ownerOfState(state)).toBe('ou_a')
    expect(store.ownerOfState('nope')).toBeUndefined()
    await expect(store.complete({ code: 'c1', state, redirectUri: 'r', openId: 'ou_b' })).rejects.toThrow(/别人发起/)
    const t = await store.complete({ code: 'c1', state, redirectUri: 'r', openId: 'ou_a', name: 'A' })
    expect(t.accessToken).toBe('uat-1')
    expect(feishu.exchanges).toEqual([{ code: 'c1', redirectUri: 'r' }])
    expect(store.ownerOfState(state)).toBeUndefined() // 一次性
    expect(store.isConnected('ou_a')).toBe(true)
    expect(await store.accessTokenFor('ou_a')).toBe('uat-1')
    // 快过期 → 自动续
    now += 7200 * 1000
    expect(await store.accessTokenFor('ou_a')).toBe('uat-1-refreshed')
    expect(feishu.refreshes).toBe(1)
    // refresh 也过期 → 需要重新授权
    now += 40 * 86400 * 1000
    expect(await store.accessTokenFor('ou_a')).toBeUndefined()
    expect(store.isConnected('ou_a')).toBe(false)
    expect(store.disconnect('ou_a')).toBe(true)
    expect(store.get('ou_a')).toBeUndefined()
    // state 过期
    const s2 = store.begin('ou_a')
    now += 11 * 60_000
    expect(store.ownerOfState(s2)).toBeUndefined()
  })
})

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-oauth-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home, FRIDAY_PROMPT_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const memory = new ChannelMemory(registry.db)
  const messageCache = new MessageCache(registry.db)
  const todos = new Todos(registry.db)
  const feishu = new FakeFeishu()
  feishu.chats = [{ chatId: 'oc_bot', name: '机器人在的群' }]
  feishu.members.set('oc_bot', new Set(['ou_alice', 'ou_bot']))
  feishu.userChats.set('uat-1', [
    { chatId: 'oc_bot', name: '机器人在的群' },
    { chatId: 'oc_private', name: '只有我在的群' },
  ])
  feishu.userHistories.set('oc_private', [historyMsg({ messageId: 'om_p1', senderName: '陆知行', text: '要自己写 sql 的话申请 insight 分析师权限', createTimeMs: Date.now() - 3600_000 })])
  feishu.identities.set('uat-1', { openId: 'ou_alice', name: '张三', tenantKey: 'tenant-synthetic' })
  const userTokens = new UserTokenStore(registry.db, feishu)
  const messages = new MessageService(asFeishuClient(feishu), messageCache, log)
  const tokens = new TokenIssuer('s')
  const sp = spaceDeps(registry.db)
  sp.spaces.ensure({ kind: 'group', chatId: 'oc_bot', openId: 'ou_alice' })
  const api = createInternalApi({ feishu: asFeishuClient(feishu), appId: cfg.feishu.appId, memory, registry, messages, messageCache, todos, userTokens, oauthRedirectUri: cfg.feishu.oauth.redirectUri, ...sp, tokens, log, maxHistoryPerCall: 50 })
  const { app } = createFakeAgent()
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, feishu: asFeishuClient(feishu), runtime, registry, memory, messages, userTokens, ...sp, tokens, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  const dm = (text: string, id = `om_${Math.random().toString(36).slice(2, 8)}`) => ({ eventId: 'e', messageId: id, chatId: 'oc_dm_alice', chatType: 'p2p' as const, msgType: 'text', text, senderOpenId: 'ou_alice', senderType: 'user', createTimeMs: Date.now(), mentions: [] })
  const dmCap = { sessionKey: 'dm:ou_alice', chatId: 'oc_dm_alice', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 0 }
  const groupCap = { sessionKey: 'msg:1', chatId: 'oc_bot', chatType: 'group' as const, requesterOpenId: 'ou_alice', scopes: [...GROUP_SCOPES], exp: 0 }
  return { cfg, feishu, userTokens, orchestrator, api, dm, dmCap, groupCap, messageCache }
}

describe('personal authorization end to end', () => {
  it('!connect sends the authorize card; pasting the redirect url completes; then DM sessions read as the user', async () => {
    const t = await setup()
    // 授权前：私聊只能看到机器人和本人都在的群
    const before = (await t.api.routes['POST /v1/chats']!(t.dmCap, {})) as { chats: { chat_id: string }[]; identity: string }
    expect(before.identity).toBe('bot')
    expect(before.chats.map((c) => c.chat_id)).toEqual(['oc_bot'])

    await t.orchestrator.handleMessage(t.dm('!connect'))
    const card = t.feishu.of('replyCard')[0]?.payload as Record<string, unknown>
    const cardJson = JSON.stringify(card)
    expect(cardText(card)).toContain('个人授权')
    const url = new URL(cardJson.match(/https:\/\/accounts\.feishu\.cn[^"]+/)![0].replace(/\\u0026/g, '&'))
    const state = url.searchParams.get('state')!
    // 默认仍然是内部 API 那个端口——飞书后台白名单配的就是它。
    // 换掉默认值等于让线上所有授权立刻 20029，所以新加的回调端口是**额外**入口，不是替换。
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7788/oauth/callback')
    expect(t.userTokens.ownerOfState(state)).toBe('ou_alice')

    // 回调不通，用户把地址贴回来
    await t.orchestrator.handleMessage(t.dm(`页面打不开 http://127.0.0.1:7788/oauth/callback?code=code_xyz_123&state=${state}`))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已连接，张三')
    expect(t.feishu.exchanges).toEqual([{ code: 'code_xyz_123', redirectUri: 'http://127.0.0.1:7788/oauth/callback' }])
    expect(t.userTokens.isConnected('ou_alice')).toBe(true)

    // 授权后：私聊会话以本人身份列群（含机器人不在的群），并能读那个群的历史
    const after = (await t.api.routes['POST /v1/chats']!(t.dmCap, {})) as { chats: { chat_id: string }[]; identity: string }
    expect(after.identity).toBe('user')
    expect(after.chats.map((c) => c.chat_id)).toEqual(['oc_bot', 'oc_private'])
    const hist = (await t.api.routes['POST /v1/chat/history']!(t.dmCap, { chat: '只有我在的群', hours_back: 24 })) as { items: { text: string }[] }
    expect(hist.items[0]?.text).toContain('insight 分析师权限')
    // 群会话不受影响：还是机器人身份，只看本群
    const g = (await t.api.routes['POST /v1/chats']!(t.groupCap, {})) as { chats: { chat_id: string }[]; identity: string }
    expect(g.identity).toBe('bot')
    expect(g.chats.map((c) => c.chat_id)).toEqual(['oc_bot'])

    // 未指定群的搜索走飞书本人搜索，命中回填进缓存
    t.feishu.searchHits = ['om_s1']
    t.feishu.messages.set('om_s1', historyMsg({ messageId: 'om_s1', chatId: 'oc_private', senderName: '陆知行', text: '数据需求模版在这里' }))
    const s = (await t.api.routes['POST /v1/messages/search']!(t.dmCap, { query: '数据需求' })) as { items: { messageId: string }[]; scope: string; complete: boolean }
    expect(s.items.map((m) => m.messageId)).toEqual(['om_s1'])
    // 搜索范围现在是结构化的一等字段（MCP 会把它写在结果最前面），不再埋在 note 里
    expect(s.scope).toContain('本人身份')
    expect(s.complete).toBe(true)
    expect(t.messageCache.get('om_s1')?.chatId).toBe('oc_private')

    // 文档：先用本人身份，读不到再退回机器人身份
    t.feishu.userDocs.set('DOC1', { title: '我的私有文档', content: '正文', objType: 'docx' })
    const doc = (await t.api.routes['POST /v1/doc']!(t.dmCap, { url: 'https://x.feishu.cn/docx/DOC1' })) as { title: string; identity: string }
    expect(doc.title).toBe('我的私有文档')
    expect(doc.identity).toBe('user')

    await t.orchestrator.handleMessage(t.dm('!disconnect'))
    expect(t.userTokens.isConnected('ou_alice')).toBe(false)
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('已解除')
  })

  it('rejects a pasted code whose state belongs to someone else, and !connect outside DMs', async () => {
    const t = await setup()
    const state = t.userTokens.begin('ou_bob')
    await t.orchestrator.handleMessage(t.dm(`!auth http://127.0.0.1:7788/oauth/callback?code=code_xyz_123&state=${state}`))
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('别人发起')
    expect(t.userTokens.isConnected('ou_alice')).toBe(false)
    await t.orchestrator.handleMessage({ ...t.dm('@Friday !connect'), chatId: 'oc_bot', chatType: 'group', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Friday' }] })
    expect(String(t.feishu.of('replyText').at(-1)?.payload)).toContain('授权卡已发到你的 Friday 私聊')
  })
})
