/**
 * dsh 子进程的代理环境。
 *
 * 开发机上模型走内网（`llm-gateway.example.com`），只有 web 工具需要出网，
 * 所以代理是可选的：`FRIDAY_DSH_PROXY=1` 才往子进程传。
 *
 * 这里踩过的坑值得记下来：NO_PROXY 里原本写了 `.deepseek.com`，
 * 本意是"内网模型端点直连"，但那个写法匹配**所有**子域，
 * 于是把公网的 `api.deepseek.com` 一起排除了——而联网搜索打的正是它。
 * 表现出来是 `web_search` 报 `fetch failed`、端点连不上，
 * 完全看不出问题其实出在一条 NO_PROXY 规则上。真机上就是这么查了半天。
 *
 * 所以规则改成**跟着配置走**：直连的是本机、私网段，以及这个部署实际配的那几个端点。
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROXY = 'http://proxy.example:3128'

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FRIDAY_HOME: mkdtempSync(join(tmpdir(), 'proxy-')), ...over } as NodeJS.ProcessEnv
}
const dshEnv = (over: Record<string, string> = {}) => loadConfig(env(over)).dsh.env
const noProxy = (over: Record<string, string> = {}) => (dshEnv(over).NO_PROXY ?? '').split(',')

describe('要不要给子进程配代理', () => {
  it('默认不配——内网直连，不需要', () => {
    expect(dshEnv().HTTPS_PROXY).toBeUndefined()
  })

  it('开了开关但没有代理地址，也不配', () => {
    expect(dshEnv({ FRIDAY_DSH_PROXY: '1' }).HTTPS_PROXY).toBeUndefined()
  })

  it('开关 + 地址都有才传，大小写两种变量名都传（不同工具认的不一样）', () => {
    const e = dshEnv({ FRIDAY_DSH_PROXY: '1', HTTPS_PROXY: PROXY })
    expect(e.HTTPS_PROXY).toBe(PROXY)
    expect(e.https_proxy).toBe(PROXY)
    expect(e.HTTP_PROXY).toBe(PROXY)
  })
})

describe('哪些地址直连', () => {
  const base = { FRIDAY_DSH_PROXY: '1', HTTPS_PROXY: PROXY }

  it('本机和私网段', () => {
    const list = noProxy(base)
    for (const d of ['localhost', '127.0.0.1', '::1', '10.0.0.0/8']) expect(list).toContain(d)
  })

  it('这个部署实际配的模型端点直连', () => {
    expect(noProxy({ ...base, DEEPSEEK_BASE_URL: 'https://llm-gateway.example.com/anthropic' }))
      .toContain('llm-gateway.example.com')
  })

  it('**公网的 api.deepseek.com 必须走代理**——联网搜索打的就是它', () => {
    // 这是那个 bug 本身：`.deepseek.com` 会把它一起排除，于是 web_search 永远 fetch failed。
    const list = noProxy({ ...base, DEEPSEEK_BASE_URL: 'https://llm-gateway.example.com/anthropic' })
    expect(list).not.toContain('api.deepseek.com')
    expect(list).not.toContain('.deepseek.com')
  })

  it('代理自己直连，否则会绕回自己', () => {
    expect(noProxy(base)).toContain('proxy.example')
  })

  it('换个内网地址不用回来改代码', () => {
    expect(noProxy({ ...base, DEEPSEEK_BASE_URL: 'https://llm.corp.internal/v1' })).toContain('llm.corp.internal')
  })

  it('人自己写的 NO_PROXY 保留', () => {
    expect(noProxy({ ...base, NO_PROXY: 'gitlab.internal' })).toContain('gitlab.internal')
  })

  it('端点配歪了不影响其余直连项', () => {
    const list = noProxy({ ...base, DEEPSEEK_BASE_URL: 'not a url' })
    expect(list).toContain('localhost')
  })
})
