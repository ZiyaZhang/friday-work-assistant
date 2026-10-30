/**
 * 一件改代码的活，从头到尾说五句话；以及"接单"这一句什么时候该出现。
 *
 * 验证群内 PR 跟进流程：
 *   收到我来处理 → 已提交但未就绪 → 已就绪请 review（写清具体改了什么）
 *   → 新问题追加到同一个 PR → 已合并
 *
 * Friday 以前只有中间一句：开 PR 一律 draft 且**没有办法变成可评审**
 * （`if (input.draft === false) throw`），所以「已就绪，请 review」这句在架构上就发不出来；
 * 合并也从不播报。接单那一句更是只有一个表情。
 *
 * 这组用例守三件事：
 * 1. draft → 可评审是一次**单独的显式动作**，而且幂等；
 * 2. 已合并 / 已关闭时不去改它，如实回报；
 * 3. "收到，我来处理"是**迟到**的——快的那些不出现，慢的那些才出现，
 *    而且一旦已经说过别的话就不再补这一句。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

describe('PR 三态：draft → 可评审 → 已合并', () => {
  /** 只造 markReady 这条路需要的东西：一个登记好的 binding + 一个假的 GitHub API。 */
  function setup(pr: Record<string, unknown>) {
    const calls: { method: string; path: string; body?: unknown }[] = []
    let current = pr
    const github = {
      api: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body })
        if (method === 'POST' && path === '/graphql') {
          current = { ...current, draft: false }
          return { data: { markPullRequestReadyForReview: { clientMutationId: null } } }
        }
        return current
      }),
    }
    return { github, calls, get current() { return current } }
  }

  const BINDING = {
    id: 'chg_1', sessionKey: 's', requesterOpenId: 'ou_alice', cwd: '/w', dir: '/w/chg',
    originWorkKey: null,
    repo: 'ZhixingLu/dsh-visualizer-benchmark', branch: 'friday/plan-tag', base: 'main',
    baseCommit: 'base1', remoteUrl: 'https://github.com/ZhixingLu/dsh-visualizer-benchmark.git',
    gitDir: '/w/chg/.git', state: 'confirmed', snapshot: 'snap', publishIntent: null,
    commitId: 'head1', prNumber: 4399, prUrl: null, result: null, error: null,
  }

  /** 真实 PR 的形状：head/base 要对得上，否则 markReady 会拒绝动它。 */
  function prPayload(over: Record<string, unknown> = {}) {
    return {
      node_id: 'PR_kwABC', html_url: 'https://github.com/ZhixingLu/dsh-visualizer-benchmark/pull/4399',
      draft: true, state: 'open', merged: false,
      head: { ref: 'friday/plan-tag', sha: 'head1', repo: { full_name: 'ZhixingLu/dsh-visualizer-benchmark' } },
      base: { ref: 'main', repo: { full_name: 'ZhixingLu/dsh-visualizer-benchmark' } },
      ...over,
    }
  }

  /** ChangeManager 的构造要一整套依赖；这里只验 markReady 的判断，所以直接搭最小可跑的。 */
  async function manager(pr: Record<string, unknown>) {
    const { ChangeManager } = await import('../src/github/changes.js')
    const t = setup(pr)
    const db = new (await import('node:sqlite')).DatabaseSync(':memory:')
    const mgr = new ChangeManager({ db, github: t.github as never, root: mkdtempSync(join(tmpdir(), 'chg-')), now: () => 1 } as never)
    // 直接把 binding 塞进去：准备副本要真的 git，那是 publish 那条路的用例覆盖的事
    ;(mgr as unknown as { binding: (dir: string) => unknown }).binding = () => BINDING
    return { mgr, ...t }
  }

  it('draft 的 PR 走一次 GraphQL 变成可评审，并回读确认', async () => {
    const t = await manager(prPayload())
    const r = await t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_alice' })
    expect(r).toMatchObject({ number: 4399, draft: false, merged: false, phase: 'ready' })
    // REST 改不了 draft 标记，所以必须走 markPullRequestReadyForReview
    const graphql = t.calls.find((c) => c.path === '/graphql')
    expect(graphql).toBeTruthy()
    expect(JSON.stringify(graphql!.body)).toContain('markPullRequestReadyForReview')
    // 不拿"请求没报错"当成"已经就绪"：改完要再读一次
    expect(t.calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2)
  })

  it('已经是可评审就直接回报，不重复调用', async () => {
    const t = await manager(prPayload({ draft: false }))
    const r = await t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_alice' })
    expect(r.phase).toBe('ready')
    expect(t.calls.some((c) => c.path === '/graphql')).toBe(false)
  })

  it('已合并的不去动它', async () => {
    const t = await manager(prPayload({ merged: true, merged_at: '2026-09-18T00:05:00Z', state: 'closed' }))
    const r = await t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_alice' })
    expect(r).toMatchObject({ merged: true, phase: 'merged' })
    expect(t.calls.some((c) => c.path === '/graphql')).toBe(false)
  })

  it('关闭但没合并的，如实说是 closed 而不是 merged', async () => {
    const t = await manager(prPayload({ state: 'closed', merged: false, draft: false }))
    const r = await t.mgr.lifecycle({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_alice' })
    expect(r).toMatchObject({ merged: false, closed: true, phase: 'closed' })
  })

  it('远端 PR 的 head/base 对不上就不许动', async () => {
    const t = await manager(prPayload({ base: { ref: 'release', repo: { full_name: 'ZhixingLu/dsh-visualizer-benchmark' } } }))
    await expect(t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_alice' }))
      .rejects.toThrow(/与本次修改不符/)
  })

  it('别人的会话或别的发起人拿不到这份修改', async () => {
    const t = await manager(prPayload())
    await expect(t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 'other', requesterOpenId: 'ou_alice' }))
      .rejects.toThrow(/不属于当前会话与发起人/)
    await expect(t.mgr.markReady({ dir: '/w/chg', cwd: '/w', sessionKey: 's', requesterOpenId: 'ou_bob' }))
      .rejects.toThrow(/不属于当前会话与发起人/)
  })
})

describe('接单那一句是迟到的', () => {
  function cfg(env: Record<string, string> = {}) {
    return loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: mkdtempSync(join(tmpdir(), 'ack-')), ...env } as NodeJS.ProcessEnv)
  }

  it('默认等一会儿才说，不是每条都说', () => {
    // 快的那些直接出结果，再补一句"收到"是噪音；慢的那些沉默着干几十分钟才是问题。
    expect(cfg().policy.ackAfterMs).toBeGreaterThan(10_000)
  })

  it('可以关掉', () => {
    expect(cfg({ FRIDAY_ACK_AFTER_MS: '0' }).policy.ackAfterMs).toBe(0)
  })

  it('配错了就直接报错，不悄悄关掉也不悄悄用默认值', () => {
    // 静默把一个功能关掉，比启动失败难查得多。
    expect(() => cfg({ FRIDAY_ACK_AFTER_MS: '-5000' })).toThrow(/非负整数/)
    expect(() => cfg({ FRIDAY_ACK_AFTER_MS: 'soon' })).toThrow(/非负整数/)
  })
})
