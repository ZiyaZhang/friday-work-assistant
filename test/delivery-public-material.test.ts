/** Links may themselves carry credentials. Return freshly fetched material only
 * to its original audience; application and personal document rules stay intact. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { SourceContexts, type SourceContext } from '../src/core/source-context.js'
import type { DeliveryAudience } from '../src/core/delivery.js'
import { DeliveryContextResolver } from '../src/core/delivery-context.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const opened: Registry[] = []
afterEach(() => { for (const r of opened.splice(0)) r.close() })

async function setup(opts: { connected?: boolean } = {}) {
  const registry = new Registry(':memory:'); opened.push(registry)
  const { spaces } = spaceDeps(registry.db)
  const dm = spaces.ensure({ kind: 'p2p', chatId: 'dm-chat', openId: 'alice' })
  const group = spaces.ensure({ kind: 'group', chatId: 'group-chat', openId: 'alice' })
  const sources = new SourceContexts(registry)
  const userTokens = new UserTokenStore(registry.db, {
    exchangeCode: async () => ({ accessToken: 'synthetic-token', expiresIn: 7200 }),
    refresh: async () => { throw new Error('unexpected refresh') },
  }, () => NOW)
  if (opts.connected !== false) {
    await userTokens.complete({ code: 'synthetic-code', openId: 'alice', redirectUri: 'http://localhost/callback' })
  }
  const feishu = {
    listChats: vi.fn(async () => [{ chatId: group.chatId!, name: 'group' }]),
    chatMemberOpenIds: vi.fn(async () => new Set(['alice'])),
  }
  const resolver = new DeliveryContextResolver({ sources, spaces, feishu, userTokens,
    disconnectPersonalConnection: () => false, now: () => NOW })
  const accessToken = vi.spyOn(userTokens, 'accessTokenResult')
  const web = (where: 'dm' | 'group', ref = 'https://example.com/jd?credential=opaque'): SourceContext['external'][number] => {
    const origin = where === 'dm' ? dm : group
    return { kind: 'web', ref, access: 'link', linkGrant: { version: 1, runId: 'run-current', acpSessionId: 'acp',
      spaceId: origin.id, chatId: origin.chatId!, chatType: origin.kind, actorOpenId: 'alice', messageId: 'human-message', requestUrl: ref, fetchedUrl: ref } }
  }

  return {
    sources, dm, group, spaces, web, accessToken,
    /** 在某个受众下解析一轮，external 里放指定的来源。 */
    async resolve(where: 'dm' | 'group', external: SourceContext['external'], options: { audience?: DeliveryAudience; runId?: string; actor?: string } = {}) {
      const origin = where === 'dm' ? dm : group
      const binding = { sessionKey: `s-${where}-${Math.random()}`, acpSessionId: 'acp', spaceId: origin.id, chatId: origin.chatId! }
      sources.initialize(binding, [])
      for (const e of external) sources.addExternal(binding.sessionKey, e)
      return resolver.resolve({
        ...binding, runId: options.runId ?? 'run-current', actorOpenId: options.actor ?? 'alice', chatType: where === 'dm' ? 'p2p' : 'group',
        isLive: () => true, isCurrent: () => true, readScopes: () => [],
      }, {
        audience: options.audience ?? (where === 'dm' ? { kind: 'dm', spaceId: dm.id, openId: 'alice' }
          : { kind: 'group', spaceId: group.id, chatId: group.chatId! }),
      })
    },
  }
}

const APP_DOC = { kind: 'document', ref: 'docx:synthetic', access: 'app' } as const
const BORROWED = { kind: 'document', ref: 'docx:private', personalOpenId: 'alice', access: 'user' } as const

describe('原群或原人链接授权', () => {
  it('本轮读过的链接内容可以发回原群', async () => {
    const t = await setup()
    expect((await t.resolve('group', [t.web('group')]))?.provenanceComplete).toBe(true)
  })

  it('这个人根本没授权过也一样——核他的授权本来就证明不了任何事', async () => {
    const t = await setup({ connected: false })
    expect((await t.resolve('group', [t.web('group')]))?.provenanceComplete).toBe(true)
    expect(t.accessToken).not.toHaveBeenCalled()
  })

  it('私聊里同样发得出去', async () => {
    const t = await setup()
    expect((await t.resolve('dm', [t.web('dm')]))?.provenanceComplete).toBe(true)
  })

  it('来源会被记进证据里，不是绕过而是如实记下', async () => {
    const t = await setup()
    const c = await t.resolve('group', [t.web('group')])
    expect(c!.sources.map(s => s.ref)).toContain('web:https://example.com/jd?credential=opaque')
  })
})

describe('用了 Friday 应用身份的，仍然拦着', () => {
  /**
   * 这一条很容易想当然地松掉：「又没借谁的身份，怕什么」。
   * 怕的是——Friday 是那篇文档的协作者，**群里的人未必是**。
   * 发到群里就是拿 Friday 的权限替别人开门。
   */
  it('群里不发', async () => {
    const t = await setup()
    expect((await t.resolve('group', [APP_DOC]))?.provenanceComplete).toBe(false)
  })

  it('私聊也不发——这条一直是这样，这次没有放宽', async () => {
    const t = await setup()
    expect((await t.resolve('dm', [APP_DOC]))?.provenanceComplete).toBe(false)
  })

  it('没标 access 的旧记录按应用身份算，不能因为加了个字段就变宽', async () => {
    const t = await setup()
    expect((await t.resolve('group', [{ kind: 'document', ref: 'docx:legacy' }]))?.provenanceComplete).toBe(false)
  })
})

describe('借了某个人的身份，就只能发回给这个人', () => {
  it('群里不发——那等于把他一个人能看的东西摊开给所有人', async () => {
    const t = await setup()
    expect((await t.resolve('group', [BORROWED]))?.provenanceComplete).toBe(false)
  })

  it('私聊发回给本人可以', async () => {
    const t = await setup()
    expect((await t.resolve('dm', [BORROWED]))?.provenanceComplete).toBe(true)
  })

  it('借的是别人的身份，连私聊也不发', async () => {
    const t = await setup()
    const someoneElse = { ...BORROWED, personalOpenId: 'bob' }
    expect((await t.resolve('dm', [someoneElse]))?.provenanceComplete).toBe(false)
  })
})

describe('混在一起时，按最严的那条来', () => {
  it('公开的 + 借来的，在群里仍然不发', async () => {
    // 不能因为里面有一份公开资料，就把借来的那份顺带放出去。
    const t = await setup()
    expect((await t.resolve('group', [t.web('group'), BORROWED]))?.provenanceComplete).toBe(false)
  })

  it('公开的 + 借来的，私聊里发给本人可以', async () => {
    const t = await setup()
    expect((await t.resolve('dm', [t.web('dm'), BORROWED]))?.provenanceComplete).toBe(true)
  })

  it('公开的 + 应用身份的，私聊也不发', async () => {
    const t = await setup()
    expect((await t.resolve('dm', [t.web('dm'), APP_DOC]))?.provenanceComplete).toBe(false)
  })
})

describe('规则写在凭证上，不是写在类型上', () => {
  it('网页要是借了身份抓的，一样按借来的算', async () => {
    // 按"文档危险、网页安全"去枚举，哪天有了要登录才能抓的页面就错了。
    const t = await setup()
    const borrowedWeb = { kind: 'web', ref: 'https://intranet/x', personalOpenId: 'alice', access: 'user' } as const
    expect((await t.resolve('group', [borrowedWeb]))?.provenanceComplete).toBe(false)
  })

  it('标了 public 却同时带着某个人的身份，按借来的算——两个字段打架时取严的', async () => {
    const t = await setup()
    const confused = { kind: 'web', ref: 'https://x/y', personalOpenId: 'alice', access: 'public' } as const
    expect((await t.resolve('group', [confused]))?.provenanceComplete).toBe(false)
  })

  it('日历同理：真公开的不限受众，应用身份读的照拦', async () => {
    const t = await setup()
    expect((await t.resolve('group', [{ kind: 'calendar', ref: 'cal:public', access: 'public' }]))?.provenanceComplete).toBe(true)
    expect((await t.resolve('group', [{ kind: 'calendar', ref: 'cal:mine', access: 'app' }]))?.provenanceComplete).toBe(false)
  })
})

describe('link grants cannot become public or a personal OAuth request', () => {
  it.each(['public', undefined, 'user', 'link'] as const)('refuses historical or incomplete web access=%s without asking for Feishu authorization', async access => {
    const t = await setup({ connected: false })
    const source = { kind: 'web' as const, ref: 'https://example.com/opaque', access,
      ...(access === 'user' ? { personalOpenId: 'alice' } : {}) }
    expect((await t.resolve('dm', [source]))?.provenanceComplete).toBe(false)
    expect(t.accessToken).not.toHaveBeenCalled()
  })

  it.each(['group', 'dm'] as const)('keeps signed and plain URLs under the same original %s audience rule', async origin => {
    const t = await setup({ connected: false }), other = t.spaces.ensure({ kind: 'group', chatId: 'another-chat', openId: 'alice' })
    for (const url of ['https://example.com/plain', 'https://example.com/opaque-path', 'https://example.com/?signature=private']) {
      const web = t.web(origin, url)
      expect((await t.resolve(origin, [web], { audience: { kind: 'group', spaceId: other.id, chatId: other.chatId! } }))?.provenanceComplete).toBe(false)
      expect((await t.resolve(origin, [web], { audience: { kind: 'dm', spaceId: t.dm.id, openId: 'bob' } }))?.provenanceComplete).toBe(false)
      if (origin === 'group') expect((await t.resolve(origin, [web], { audience: { kind: 'dm', spaceId: t.dm.id, openId: 'alice' } }))?.provenanceComplete).toBe(false)
      else expect((await t.resolve(origin, [web], { audience: { kind: 'group', spaceId: t.group.id, chatId: t.group.chatId! } }))?.provenanceComplete).toBe(false)
    }
    expect(t.accessToken).not.toHaveBeenCalled()
  })

  it('refuses a copied receipt for another Run, actor, origin or URL rather than laundering it through the original space', async () => {
    const t = await setup({ connected: false })
    const web = t.web('group')
    expect((await t.resolve('group', [web], { runId: 'next-run' }))?.provenanceComplete).toBe(false)
    expect((await t.resolve('group', [web], { actor: 'bob' }))?.provenanceComplete).toBe(false)
    for (const patch of [{ fetchedUrl: 'https://other.example/opaque' }, { requestUrl: 'https://other.example/opaque' },
      { spaceId: 'other-space' }, { chatId: 'other-chat' }, { acpSessionId: 'other-acp' }, { messageId: '' }]) {
      expect((await t.resolve('group', [{ ...web, linkGrant: { ...web.linkGrant!, ...patch } }]))?.provenanceComplete).toBe(false)
    }
    expect((await t.resolve('group', [{ ...web, ref: 'https://example.com/another' }]))?.provenanceComplete).toBe(false)
    expect(t.accessToken).not.toHaveBeenCalled()
  })
})
