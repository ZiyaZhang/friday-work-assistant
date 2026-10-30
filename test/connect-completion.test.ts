import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { completeConnection } from '../src/feishu/connect-completion.js'
import { FakeFeishu } from './helpers/fake-feishu.js'

const registries: Registry[] = []
afterEach(() => { registries.splice(0).forEach(r => r.close()) })
function setup() {
  const registry = new Registry(':memory:'); registries.push(registry)
  const provider = new FakeFeishu()
  const userTokens = new UserTokenStore(registry.db, provider)
  const deps = { userTokens, redirectUri: 'https://callback.example/oauth/callback',
    whoAmI: vi.fn(async () => ({ openId: 'ou_alice', name: 'Alice' })),
    onCompleted: vi.fn(async () => ({ connected: true, resumed: 1 })),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }
  return { provider, userTokens, deps }
}

describe('verify identity before committing an OAuth grant', () => {
  it.each(['wrong-person', 'missing-person', 'provider-failure'])('keeps the previous grant when identity is %s', async kind => {
    const { provider, userTokens, deps } = setup()
    await userTokens.complete({ code: 'old', state: userTokens.begin('ou_alice'), redirectUri: deps.redirectUri })
    const previous = userTokens.get('ou_alice')
    provider.nextToken = { accessToken: 'different-access', expiresIn: 7200, scope: 'docx:document:readonly' }
    deps.whoAmI = vi.fn(async () => {
      if (kind === 'provider-failure') throw new Error('secret-provider-response')
      return { openId: kind === 'wrong-person' ? 'ou_bob' : '', name: 'B' }
    })
    const outcome = await completeConnection(deps, { code: 'new', state: userTokens.begin('ou_alice') })
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain('secret-provider-response')
    expect(userTokens.get('ou_alice')).toEqual(previous)
    expect(deps.onCompleted).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'new-request'])('does not save a late response after %s', async action => {
    const { userTokens, deps } = setup()
    let finish!: (identity: { openId: string; name: string }) => void
    deps.whoAmI = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const state = userTokens.begin('ou_alice')
    const pending = completeConnection(deps, { code: 'first', state })
    await vi.waitFor(() => expect(deps.whoAmI).toHaveBeenCalledOnce())
    if (action === 'disconnect') userTokens.disconnect('ou_alice')
    else userTokens.begin('ou_alice')
    finish({ openId: 'ou_alice', name: 'Alice' })
    expect((await pending).ok).toBe(false)
    expect(userTokens.get('ou_alice')).toBeUndefined()
  })

  it('consumes a callback before exchange and keeps successful grants when recovery fails', async () => {
    const { provider, userTokens, deps } = setup()
    deps.onCompleted.mockRejectedValueOnce(new Error('recovery unavailable'))
    const input = { code: 'one-code', state: userTokens.begin('ou_alice') }
    const [first, repeated] = await Promise.all([completeConnection(deps, input), completeConnection(deps, input)])
    expect(first.ok).toBe(true)
    expect(first.detail).toContain('暂未恢复')
    expect(repeated.ok).toBe(false)
    expect(provider.exchanges).toHaveLength(1)
    expect(userTokens.isConnected('ou_alice')).toBe(true)
  })
})
