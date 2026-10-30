import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { UserTokenStore, USER_SCOPE_TIERS } from '../src/feishu/oauth.js'
import { MINUTES_SCOPES } from '../src/feishu/minutes.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-minutes-connect-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home } as NodeJS.ProcessEnv)
  const registry = new Registry(':memory:'), sp = spaceDeps(registry.db)
  sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'alice' })
  const feishu = new FakeFeishu(), { app } = createFakeAgent(), log = createLogger('minutes-connect', 'error')
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app }, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log })
  let scope = USER_SCOPE_TIERS.core.join(' ')
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'synthetic-user-token', scope, expiresIn: 7200 }), refresh: vi.fn() })
  const orchestrator = new Orchestrator({ cfg, registry, ...sp, memory: new ChannelMemory(registry.db), feishu: asFeishuClient(feishu), runtime,
    userTokens, tokens: new TokenIssuer('synthetic-capability-secret'), apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  const connect = async (granted = USER_SCOPE_TIERS.core.join(' ')) => {
    scope = granted
    await userTokens.complete({ openId: 'alice', code: 'synthetic', redirectUri: 'https://callback.invalid' })
  }
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const actor = { chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'alice', sessionKey: 'synthetic-session' }
  const cardScopes = () => {
    const payload = feishu.of('sendToUser').at(-1)!.payload as { card: { body: { elements: { tag: string; behaviors?: { default_url?: string }[] }[] } } }
    const url = payload.card.body.elements.find(element => element.tag === 'button')!.behaviors![0]!.default_url!
    return new URL(url).searchParams.get('scope')!.split(' ')
  }
  return { feishu, cfg, userTokens, orchestrator, connect, actor, cardScopes }
}

describe('On-demand Minutes scope upgrade', () => {
  it('gives a connected core-only user a card that actually requests Minutes', async () => {
    const t = setup(); await t.connect()
    const said = await t.orchestrator.abilities.offerConnect(t.actor, ['minutes'])
    expect(said).toContain('补充个人权限'); expect(said).toContain('已经发给你')
    expect(t.cardScopes()).toEqual(expect.arrayContaining(Object.values(MINUTES_SCOPES)))
    expect(t.cardScopes()).not.toContain('calendar:calendar:readonly')
    expect(t.cardScopes()).not.toContain('im:message.group_msg:get_as_user')
    expect(t.cardScopes()).not.toContain('im:message')
    expect(t.cfg.feishu.oauth.scopes).not.toContain(MINUTES_SCOPES.search)
  })

  it('does not silently downgrade prior known scopes when adding Minutes', async () => {
    const t = setup(); await t.connect([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.calendar, ...USER_SCOPE_TIERS.watch, 'unrequested:unknown', 'im:message'].join(' '))
    await t.orchestrator.abilities.offerConnect(t.actor, ['minutes'])
    expect(t.cardScopes()).toEqual(expect.arrayContaining([...USER_SCOPE_TIERS.calendar, ...USER_SCOPE_TIERS.watch, ...USER_SCOPE_TIERS.minutes]))
    expect(t.cardScopes()).not.toContain('unrequested:unknown'); expect(t.cardScopes()).not.toContain('im:message')
    expect(new Set(t.cardScopes()).size).toBe(t.cardScopes().length)
  })

  it('leaves ordinary login unchanged and does not nudge a fully authorized user', async () => {
    const ordinary = setup(); await ordinary.orchestrator.abilities.offerConnect(ordinary.actor)
    expect(ordinary.cardScopes()).toEqual(ordinary.cfg.feishu.oauth.scopes)
    const t = setup(); await t.connect([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.minutes].join(' '))
    expect(await t.orchestrator.abilities.offerConnect(t.actor, ['minutes'])).toBe('')
    expect(t.feishu.of('sendToUser')).toHaveLength(0)
  })

  it('requests the Minutes tier at first connection when the explicit task needs it', async () => {
    const t = setup(); await t.orchestrator.abilities.offerConnect(t.actor, ['minutes'])
    expect(t.cardScopes()).toEqual(expect.arrayContaining([...USER_SCOPE_TIERS.core, ...USER_SCOPE_TIERS.minutes]))
  })

  it('does not claim the card was sent after a Feishu send failure', async () => {
    const t = setup(); await t.connect(); vi.spyOn(t.feishu, 'sendToUser').mockRejectedValue(new Error('synthetic unavailable'))
    await expect(t.orchestrator.abilities.offerConnect(t.actor, ['minutes'])).rejects.toThrow('synthetic unavailable')
  })
})
