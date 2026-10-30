/**
 * 取码轮询。
 *
 * 守的都是"别烦人"和"别撒谎"：
 * - 没人在授权的时候一个请求都不发；
 * - 网络不通不等于授权失败，不能因此去跟人说"你授权失败了"；
 * - 过期了就安静放手——他很可能根本没打算授权，去提醒一次反而是骚扰。
 */
import { describe, expect, it, vi } from 'vitest'
import { OAuthRelay } from '../src/feishu/oauth-relay.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

type Responder = (url: string, init?: { headers: Record<string, string> }) => Promise<Response>

function relay(responses: Responder[] | Responder, over: Record<string, unknown> = {}) {
  const codes: { openId: string; code: string }[] = []
  const denied: { openId: string; reason: string }[] = []
  const calls: string[] = []
  let i = 0
  const fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes('/relay/ack')) return new Response('{}', { status: 200 })
    calls.push(String(url))
    const next = Array.isArray(responses) ? responses[Math.min(i++, responses.length - 1)] : responses
    return next!(String(url), init as { headers: Record<string, string> })
  }) as unknown as typeof globalThis.fetch
  let clock = 1_000_000
  const r = new OAuthRelay({
    baseUrl: 'https://friday-oauth.example.workers.dev', token: 'shhh', fetch, log,
    now: () => clock,
    onCode: async ({ openId, code }) => { codes.push({ openId, code }) },
    onDenied: async ({ openId, reason }) => { denied.push({ openId, reason }) },
    ...over,
  }, 60_000, 10 * 60_000)
  return { r, codes, denied, calls, at: (t: number) => { clock = t }, now: () => clock }
}

const ok = (body: unknown, status = 200): Responder => async () => new Response(JSON.stringify(body), { status })

describe('没人在授权就不发请求', () => {
  it('没 watch 过，tick 一次也不出网', async () => {
    const t = relay(ok({ pending: true }))
    await t.r.tick()
    expect(t.calls).toEqual([])
  })

  it('取到之后就不再盯着它——循环自己停下来', async () => {
    const t = relay(ok({ code: 'c_1' }))
    t.r.watch('st_abc', 'ou_alice')
    expect(t.r.size).toBe(1)
    await t.r.tick()
    expect(t.r.size).toBe(0)
    await t.r.tick()
    expect(t.calls.length).toBe(1)
  })
})

describe('取到 code', () => {
  it('交给 onCode，带上是谁发起的', async () => {
    const t = relay(ok({ code: 'c_1' }))
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(t.codes).toEqual([{ openId: 'ou_alice', code: 'c_1' }])
    expect(t.denied).toEqual([])
  })

  it('请求里带 bearer——Worker 那边只认这个', async () => {
    let seen: Record<string, string> | undefined
    const t = relay(async (_u, init) => {
      seen = init?.headers
      return new Response(JSON.stringify({ code: 'c' }), { status: 200 })
    })
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(seen?.authorization).toBe('Bearer shhh')
  })

  it('state 放在查询串里且做了转义', async () => {
    const t = relay(ok({ code: 'c' }))
    t.r.watch('st_a+b/c', 'ou_alice')
    await t.r.tick()
    expect(t.calls[0]).toContain('/relay/claim?state=st_a%2Bb%2Fc')
  })
})

describe('Worker 还没收到就接着等', () => {
  it('404 是"还没来"，不是失败', async () => {
    const t = relay([ok({}, 404), ok({}, 404), ok({ code: 'c_9' })])
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick(); await t.r.tick()
    expect(t.codes).toEqual([])
    expect(t.denied).toEqual([])
    await t.r.tick()
    expect(t.codes).toEqual([{ openId: 'ou_alice', code: 'c_9' }])
  })
})

describe('网络不通 ≠ 授权失败', () => {
  it('出网失败时既不告诉人失败，也不放弃', async () => {
    // 容器出网抖一下就跟人说"你授权失败了"，是把我们的问题说成他的问题。
    const boom: Responder = async () => { throw new Error('ECONNRESET') }
    const t = relay([boom, boom, ok({ code: 'c_7' })])
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick(); await t.r.tick()
    expect(t.denied).toEqual([])
    expect(t.r.size).toBe(1)
    await t.r.tick()
    expect(t.codes).toEqual([{ openId: 'ou_alice', code: 'c_7' }])
  })

  it('Worker 挂了（5xx）同理，继续等', async () => {
    const t = relay(ok({}, 502))
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(t.denied).toEqual([])
    expect(t.r.size).toBe(1)
  })

  it('token 配错是配置问题，不是这个人的问题——不去打扰他', async () => {
    const t = relay(ok({ error: 'unauthorized' }, 401))
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(t.denied).toEqual([])
  })
})

describe('人自己拒绝了才去说一声', () => {
  it('Worker 明说 denied 时告诉本人原因', async () => {
    const t = relay(ok({ error: 'denied', detail: 'access_denied: 用户取消' }))
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(t.denied).toEqual([{ openId: 'ou_alice', reason: '这次没有完成飞书授权' }])
    expect(t.codes).toEqual([])
  })

  it('410 过期也说一声——他确实点过，只是太久了', async () => {
    const t = relay(ok({}, 410))
    t.r.watch('st_abc', 'ou_alice')
    await t.r.tick()
    expect(t.denied[0]?.reason).toContain('过期')
  })
})

describe('等过了有效期就安静放手', () => {
  it('不去跟人说"超时了"——他很可能根本没打算授权', async () => {
    const t = relay(ok({}, 404))
    t.r.watch('st_abc', 'ou_alice')
    t.at(t.now() + 11 * 60_000)
    await t.r.tick()
    expect(t.r.size).toBe(0)
    expect(t.denied).toEqual([])
    expect(t.codes).toEqual([])
    // 已经放手了，不该再发请求
    expect(t.calls).toEqual([])
  })
})

describe('同一个 state 不重复盯', () => {
  it('watch 两次只算一个', async () => {
    const t = relay(ok({ code: 'c' }))
    t.r.watch('st_abc', 'ou_alice')
    t.r.watch('st_abc', 'ou_alice')
    expect(t.r.size).toBe(1)
    await t.r.tick()
    expect(t.codes.length).toBe(1)
  })
})

describe('onCode 自己炸了不能把轮询也带走', () => {
  it('交接失败时记下来，但不卡住其他人的授权', async () => {
    const t = relay(ok({ code: 'c' }), { onCode: async () => { throw new Error('boom') } })
    t.r.watch('st_a', 'ou_alice')
    t.r.watch('st_b', 'ou_bob')
    await expect(t.r.tick()).resolves.toBeUndefined()
    expect(t.r.size).toBe(0)
  })
})

describe('定时器不拖住进程', () => {
  it('close 之后不再有定时器在跑', () => {
    const t = relay(ok({ pending: true }))
    const spy = vi.spyOn(globalThis, 'clearInterval')
    t.r.watch('st_abc', 'ou_alice')
    t.r.close()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
