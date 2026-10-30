/**
 * 缺授权 / 缺信息的时候，不许把命令当答案丢回去。
 *
 * 起因是真机上这一幕：问"你能看到哪些群"，回的是一张灰卡片写着"私聊发 /connect 完成个人授权"。
 * 可授权卡本来就有一个「打开授权页面」按钮——该点的东西我们手里有，却要求他先知道有这么个命令、
 * 再自己打一遍。大部分人不会用斜杠命令，这一步就是把人劝退的地方。
 *
 * 所以这组用例守两件事：
 * 1. **挡住他的时候给入口**：能弹能点的授权卡就弹卡，不发"请发 /xxx"。
 * 2. **缺他才知道的信息就问**：GitHub 用户名这种只有他知道的，问一句然后自己记下来，而不是教他命令。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { UserTokenStore, type TokenExchange } from '../src/feishu/oauth.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

/** 教人敲命令的说法。回复里出现这些，就是把我们该做的事推给了用户。 */
const TEACHES_A_COMMAND = /发\s*[/!]\w+|输入\s*[/!]\w+|私聊发\s*`?[/!]/

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-no-dead-end-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: home } as NodeJS.ProcessEnv)
  const registry = new Registry(':memory:')
  const sp = spaceDeps(registry.db)
  sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' })
  const feishu = new FakeFeishu()
  const { app } = createFakeAgent()
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  const exchange: TokenExchange = { accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 7200, refreshToken: 'R', refreshTokenExpiresIn: 86400, scope: 'im:chat:readonly' }
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: vi.fn(async () => exchange), refresh: vi.fn(async () => exchange) })
  const readScope = new ChatReadScope(registry.db)
  const orchestrator = new Orchestrator({
    cfg, registry, routines: new RoutineStore(registry.db), ...sp,
    memory: new ChannelMemory(registry.db), feishu: asFeishuClient(feishu), runtime,
    userTokens, readScope,
    tokens: new TokenIssuer('test'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log,
  })
  feishu.listChatsResult = vi.fn(async () => ({ items: [{ chatId: 'oc_team', name: '数仓对接群' }], complete: true }))
  const connect = () => userTokens.complete({ openId: 'ou_alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  return { cfg, registry, feishu, orchestrator, userTokens, readScope, connect }
}

/** 私聊里发一条消息，返回这一轮发出去的卡片/文本。 */
async function ask(t: ReturnType<typeof setup>, text: string) {
  const before = t.feishu.sent.length
  await t.orchestrator.handleMessage({
    eventId: `ev_${before}`, messageId: `om_${before}`, chatId: 'oc_dm', chatType: 'p2p',
    msgType: 'text', text, senderOpenId: 'ou_alice', senderType: 'user', mentions: [], createTimeMs: Date.now(),
  })
  return t.feishu.sent.slice(before)
}

describe('挡住他的时候给入口，不给命令', () => {
  it('还没授权时问"你能看到哪些群"，给的是能点的授权卡', async () => {
    const t = setup()
    const sent = await ask(t, '/groups')
    const card = sent.find((s) => s.kind === 'replyCard')
    expect(card).toBeTruthy()
    const json = JSON.stringify(card!.payload)
    // 卡上有真的能点的那一步
    expect(json).toContain('打开授权页面')
    expect(json).toContain('open_url')
    // 而不是让他回头自己敲命令
    expect(json).not.toMatch(TEACHES_A_COMMAND)
  })

  it('授权之后同一个问题给的是读取范围卡，不是又一张授权卡', async () => {
    const t = setup()
    await t.connect()
    const sent = await ask(t, '/groups')
    const json = JSON.stringify(sent.find((s) => s.kind === 'replyCard')!.payload)
    expect(json).toContain('排除')
    expect(json).toContain('数仓对接群')
    expect(json).not.toContain('打开授权页面')
  })

  it('范围卡上的按钮点不动时，把授权卡送到私聊，而不是提示去敲命令', async () => {
    const t = setup()
    const result = await t.orchestrator.handleCardAction({
      value: { action: 'scope', op: 'exclude', chat_id: 'oc_team' }, operatorOpenId: 'ou_alice', chatId: 'oc_dm', messageId: 'om_scope', raw: {},
    })
    const pushed = t.feishu.of('sendToUser').at(-1)
    expect(pushed, '应该把授权卡推到私聊').toBeTruthy()
    expect(JSON.stringify(pushed!.payload)).toContain('打开授权页面')
    expect(JSON.stringify(result)).not.toMatch(TEACHES_A_COMMAND)
  })

  it('授权卡每次都带一个新的 state，不会复用上一次的授权链接', async () => {
    const t = setup()
    const first = JSON.stringify((await ask(t, '/groups')).find((s) => s.kind === 'replyCard')!.payload)
    const second = JSON.stringify((await ask(t, '/groups')).find((s) => s.kind === 'replyCard')!.payload)
    const stateOf = (s: string) => s.match(/state=([^&"\\]+)/)?.[1]
    expect(stateOf(first)).toBeTruthy()
    expect(stateOf(second)).toBeTruthy()
    expect(stateOf(first)).not.toBe(stateOf(second))
  })
})

describe('人话问和敲命令问，走到同一个地方', () => {
  const actor = { chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', sessionKey: 'session-a' }

  it('用人话问"你能看到哪些群"，没授权也会把授权卡发过去', async () => {
    const t = setup()
    const said = await t.orchestrator.abilities.groups(actor)
    const pushed = t.feishu.of('sendToUser').at(-1)
    expect(pushed, '应该主动把授权卡发到私聊').toBeTruthy()
    expect(JSON.stringify(pushed!.payload)).toContain('打开授权页面')
    // 给模型的那段话也不能变成命令说明书
    expect(said).not.toMatch(TEACHES_A_COMMAND)
    expect(said).toContain('授权卡已经发给你了')
  })

  it('已授权时不再重复推授权卡', async () => {
    const t = setup()
    await t.connect()
    const said = await t.orchestrator.abilities.groups(actor)
    expect(t.feishu.of('sendToUser')).toHaveLength(0)
    expect(said).toContain('已连接你的飞书账号')
  })

  it('私聊里不提联盟命令——联盟是群的事，跟他说一声就行', async () => {
    const t = setup()
    await t.connect()
    const said = await t.orchestrator.abilities.groups(actor)
    expect(said).not.toContain('/groups join')
  })
})

describe('同一个问题的两条路，行为必须一样', () => {
  const actor = { chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', sessionKey: 'session-a' }

  /**
   * 真机上抓到的缺陷：命令那条路会弹授权卡，人话那条不会。
   * 因为"我能看到哪些群"在两个地方各实现了一份——宿主一份，内部 API 的能力入口又自己写了一份。
   * 所以"缺授权时该做什么"必须只有一处实现，两条路都叫它。
   */
  it('offerConnect 把卡发过去，并给出该说的那句话', async () => {
    const t = setup()
    const said = await t.orchestrator.abilities.offerConnect(actor)
    const pushed = t.feishu.of('sendToUser').at(-1)
    expect(pushed).toBeTruthy()
    expect(JSON.stringify(pushed!.payload)).toContain('打开授权页面')
    expect(said).toContain('授权卡已经发给你了')
    expect(said).not.toMatch(TEACHES_A_COMMAND)
  })

  it('已经连上了就不再打扰：不推卡，也没有话要说', async () => {
    const t = setup()
    await t.connect()
    expect(await t.orchestrator.abilities.offerConnect(actor)).toBe('')
    expect(t.feishu.of('sendToUser')).toHaveLength(0)
  })

  it('接线处把每一条能力都接上了，一条都不少', () => {
    // 这里必须逐条列（getter 会在构造时求值，那时 orchestrator 还没赋值，网关直接起不来）。
    // 所以防漏靠类型：ApiDeps 里这些字段是必填的。这条只是把"别漏"钉在测试里再说一遍。
    const index = readFileSync(new URL('../src/index.ts', import.meta.url).pathname, 'utf8')
    const wiring = index.slice(index.indexOf('abilities: {'))
    const body = wiring.slice(0, wiring.indexOf('\n    },'))
    for (const name of ['status', 'report', 'wiki', 'handover', 'groups', 'offerConnect', 'pmo', 'settings', 'explain', 'selfcheck']) {
      expect(body, `能力 ${name} 没接上，它会静默失效`).toContain(`${name}:`)
    }
    expect(index).not.toContain('get abilities()')
  })

  it('内部 API 的能力入口不许自己实现一份，必须委托给宿主', () => {
    const api = readFileSync(new URL('../src/internal/api.ts', import.meta.url).pathname, 'utf8')
    const groupsCase = api.slice(api.indexOf("case 'groups': {"))
    const body = groupsCase.slice(0, groupsCase.indexOf('\n        }'))
    expect(body, '「你能看到哪些群」走人话这条路时，也要把授权卡给出去').toContain('abilities.offerConnect')
  })
})

describe('缺他才知道的信息就问一句', () => {
  it('没记过 GitHub 用户名时是问句，不是命令说明书', async () => {
    const t = setup()
    const sent = await ask(t, '/github')
    const said = String(sent.find((s) => s.kind === 'replyText')!.payload)
    expect(said).toContain('GitHub 用户名是什么')
    expect(said).not.toMatch(TEACHES_A_COMMAND)
    expect(said).not.toContain('<登录名>')
  })

  it('已经记过就直接说记的是谁，改也用人话改', async () => {
    const t = setup()
    await ask(t, '/github ZhixingLu')
    const said = String((await ask(t, '/github')).find((s) => s.kind === 'replyText')!.payload)
    expect(said).toContain('ZhixingLu')
    expect(said).not.toMatch(TEACHES_A_COMMAND)
  })
})
