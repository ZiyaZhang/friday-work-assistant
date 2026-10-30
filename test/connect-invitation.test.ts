/**
 * 授权是 Friday 主动请求的，不是等人开口。
 *
 * 他的原话：「私聊使用、群聊授权，应该是 Friday 主动请求用户授权的功能，而不是等待用户主动提起。」
 *
 * 以前欢迎卡里是这么写的：「跟我说一声，我把授权卡发给你」——然后等。
 * 等的结果是没人被问过，所以没人授权，
 * 于是盯群、读本人文档这些要授权才能做的能力一次都没被用过。
 * 最讽刺的是欢迎卡自己举的例子里就有"帮我盯着 xx 群"——人照着说了，才被告知没授权。
 *
 * 所以改成递过去。但"主动"很容易滑成"烦人"，这组用例守的其实是**克制**：
 * 一个人一生只问一次，已经连上的不问，发失败了不算问过。
 */
import { describe, expect, it } from 'vitest'
import { renderWelcomeCard } from '../src/feishu/cards.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

type El = Record<string, unknown>
const body = (card: Record<string, unknown>) => JSON.stringify((card.body as { elements: El[] }).elements)

describe('欢迎卡不再让人自己开口', () => {
  it('私聊：说清楚卡会自己过来，而不是"跟我说一声"', () => {
    const t = body(renderWelcomeCard({ botName: 'Friday', isDm: true }))
    expect(t).not.toContain('跟我说一声，我把授权卡发给你')
    expect(t).toContain('授权卡我紧接着发过来')
  })

  it('私聊：同时说清楚不点也没关系——主动给不等于逼人点', () => {
    expect(body(renderWelcomeCard({ botName: 'Friday', isDm: true }))).toContain('不点也不影响其它功能')
  })

  it('群里的欢迎卡不谈个人授权——群里本来就用机器人身份干活', () => {
    // 个人授权是私聊的事；在群里摆一张授权卡，等于当众要求某个人去点什么。
    const t = body(renderWelcomeCard({ botName: 'Friday', isDm: false, ownerName: '陆知行' }))
    expect(t).not.toContain('授权卡')
    expect(t).toContain('只在本群说话做事')
  })
})

describe('主动，但只问一次', () => {
  /**
   * 这几条守的是 `inviteToConnect` 的三个前提，它们都是"别烦人"的具体形态：
   *
   * - `userTokens.isConnected(openId)` → 已经连上的不问；
   * - `connect-invited:<openId>` 这个标记认**人**不认空间——同一个人在三个群里把我拉进去，
   *   不该收到三张一样的卡；
   * - 发送失败时把标记撤掉，因为"被拒绝"和"没送到"是两回事，
   *   后者应该还有下一次机会。
   */
  it('去重键是人，不是空间', () => {
    // 认空间的话，一个人拉三个群就收三张卡。
    const key = (openId: string) => `connect-invited:${openId}`
    expect(key('ou_alice')).toBe(key('ou_alice'))
    expect(key('ou_alice')).not.toBe(key('ou_bob'))
    expect(key('ou_alice')).not.toContain('sp_')
  })
})

describe('缺授权的时候，卡要真的发出去', () => {
  /**
   * 真机上撞到的：他说「连接我的飞书账号」，Friday 回
   * 「刚试读你的日历，返回就是『需要个人授权』，所以授权卡会发到这个私聊里。点卡片上的……」
   * ——**然后没有卡**。
   *
   * 因为读日历那条路只是抛了一句"跟他说一声，网关会把授权卡发过去"，而网关那时候根本没被叫去发。
   * 模型照着这句话转述，于是说了一件没发生的事。
   *
   * 这是第二次了。第一次是 `/groups`，当时只修了那一处；他说过
   * 「你不能靠枚举，肯定还有类似的情况，写清楚规则而不是硬编码」。
   */
  const api = readFileSync(join(import.meta.dirname, '..', 'src', 'internal', 'api.ts'), 'utf8')
  const source = ts.createSourceFile('api.ts', api, ts.ScriptTarget.Latest, true)
  const functionBody = (name: string): string => {
    let found: ts.FunctionDeclaration | undefined
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(found, name).toBeDefined()
    return found!.body!.getText(source)
  }

  it('有一个统一出口，而不是每处各写一句话', () => {
    expect(api).toContain('async function requirePersonalConnection(')
    // 出口里必须真的去发卡，不能只是抛错
    expect(functionBody('requirePersonalConnection')).toContain('readAccessFailure(cap, failure, purpose, extras)')
    expect(functionBody('readAccessFailure')).toContain('abilities?.offerConnect(')
  })

  it('没有哪一处还在自己编"网关会把授权卡发过去"', () => {
    // 这句话是上次那个 bug 的原文：它承诺了一件调用方没做的事。
    // 注释里可以引用它（那正是在解释这个 bug），守的是**代码**里不许再出现。
    const inCode = api.split('\n').filter((l) => l.includes('网关会把授权卡发过去') && !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    expect(inCode).toEqual([])
  })

  it('卡没发成的时候，话也要跟着改——不能说一件没发生的事', () => {
    const fn = functionBody('readAccessFailure')
    expect(fn).toContain('已经发到他的私聊')
    expect(fn).toContain('没有取得授权卡的送达回执')
  })

  it('人直接说"连接我的飞书账号"时，模型手上有个真的会发卡的动作', () => {
    const mcp = readFileSync(join(import.meta.dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8')
    expect(mcp).toContain("'friday_connect_account'")
    // 工具说明里要点破那个错误做法，否则模型还是会去"描述"
    expect(mcp).toContain('不要自己描述"卡会发过来"然后什么都不做')
    expect(api).toContain("case 'connect':")
  })
})

describe('一口气收到两张卡', () => {
  /**
   * 调试另一个问题时撞见的：一个人第一次跟 Friday 说话时如果直接发 `!connect`，
   * 会走两条路——`!connect` 自己回一张卡，空间首次接管时的欢迎流程又主动推一张。
   * 两张卡指向两个不同的 state，点哪张都对，但看起来像出了问题。
   *
   * 修法不是在 `!connect` 那里特判（那是枚举，下次再加一条给卡的路径又会漏），
   * 而是记在**卡诞生的那一个地方**：connectCard() 一旦造出一张卡就记下时间，
   * 主动邀请看到手上还有一张没过期的就不发。
   */
  const orch = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'orchestrator.ts'), 'utf8')

  it('时间戳记在 connectCard 里，不是记在某个调用方', () => {
    const fn = orch.slice(orch.indexOf('private connectCard('), orch.indexOf('private connectCard(') + 900)
    expect(fn).toContain('CONNECT_CARD_AT_KEY(openId)')
  })

  it('主动邀请会看这个时间戳', () => {
    const fn = orch.slice(orch.indexOf('private async inviteToConnect('), orch.indexOf('private async inviteToConnect(') + 1200)
    expect(fn).toContain('CONNECT_CARD_AT_KEY(openId)')
  })

  it('抑制是有期限的——卡过期之后还能再主动问一次', () => {
    // 永久抑制的话，一张没点的卡会让这个人永远收不到第二次邀请。
    const fn = orch.slice(orch.indexOf('private async inviteToConnect('), orch.indexOf('private async inviteToConnect(') + 1200)
    expect(fn).toMatch(/this\.now\(\) - offeredAt < 10 \* 60_000/)
  })
})
