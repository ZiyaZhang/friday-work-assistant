import { generateKeyPairSync, createVerify } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { GitHubIdentity, loadGitHubConfig, signAppJwt, type GitHubHttp } from '../src/github/identity.js'
import { createInternalApi } from '../src/internal/api.js'
import { IssueLinks, fingerprintOf } from '../src/github/issues.js'
import { ALL_SCOPES, TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const log = createLogger('test', 'error')

function fakeGitHub() {
  const calls: { method: string; path: string; auth?: string; body?: unknown }[] = []
  let tokenCount = 0
  const http: GitHubHttp = {
    async request(method, path, body, headers = {}) {
      calls.push({ method, path, auth: headers.authorization, body })
      if (path.startsWith('/app/installations/') && path.endsWith('/access_tokens')) {
        tokenCount += 1
        return { status: 201, data: { token: `ghs_tok${tokenCount}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } as never }
      }
      if (path === '/app') return { status: 200, data: { slug: 'friday-bot' } as never }
      if (path.startsWith('/app/installations?')) return { status: 200, data: [{ id: 9, account: { login: 'org' } }, { id: 77, account: { login: 'someone' } }] as never }
      if (path.startsWith('/installation/repositories')) return { status: 200, data: { total_count: 2, repositories: [{ full_name: 'org/a' }, { full_name: 'org/b' }] } as never }
      if (path.startsWith('/search/issues')) {
        const q = decodeURIComponent(path.split('q=')[1]!.split('&')[0]!)
        return { status: 200, data: { total_count: 1, items: [{ number: 42, title: `匹配 ${q}`, state: 'open', html_url: 'https://github.com/org/a/issues/42', repository_url: 'https://api.github.com/repos/org/a', user: { login: 'alice' }, assignees: [{ login: 'ZhixingLu' }], labels: [{ name: 'kind/bug' }], updated_at: '2026-09-18T01:00:00Z', comments: 3 }] } as never }
      }
      if (path === '/repos/org/a/issues/42') return { status: 200, data: { number: 42, title: '登录报错', state: 'open', html_url: 'u', user: { login: 'alice' }, assignees: [], labels: [], created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-18T00:00:00Z', body: '复现步骤…', pull_request: undefined } as never }
      if (method === 'GET' && path.startsWith('/repos/org/a/issues/42/comments')) return { status: 200, data: [{ user: { login: 'bob' }, created_at: '2026-09-18T00:30:00Z', body: '我也遇到了' }] as never }
      if (path === '/repos/org/a/issues/7') return { status: 404, data: { message: 'Not Found' } as never }
      // 写侧
      if (method === 'POST' && path === '/repos/org/a/issues') {
        const b = body as { title: string }
        return { status: 201, data: { number: 101, title: b.title, html_url: 'https://github.com/org/a/issues/101', state: 'open' } as never }
      }
      if (path === '/repos/org/a/issues/101') return { status: 200, data: { number: 101, title: '登录页在 Safari 上白屏', state: 'open', html_url: 'https://github.com/org/a/issues/101', assignees: [], labels: [] } as never }
      if (method === 'POST' && path === '/repos/org/a/issues/101/comments') return { status: 201, data: { html_url: 'https://github.com/org/a/issues/101#issuecomment-1' } as never }
      if (method === 'POST' && path === '/repos/org/a/issues/42/comments') return { status: 201, data: { html_url: 'https://github.com/org/a/issues/42#issuecomment-9' } as never }
      return { status: 404, data: { message: `no route ${path}` } as never }
    },
  }
  return { http, calls }
}

describe('GitHub identity', () => {
  it('signs an RS256 app JWT that verifies with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const jwt = signAppJwt('123', pem, 1_700_000_000)
    const [h, p, sig] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '123' })
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url')).toBe(true)
  })

  it('mints and caches installation tokens in app mode; pat mode passes the token through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'friday-gh-'))
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    writeFileSync(join(dir, 'app.pem'), pem)
    const cfg = loadGitHubConfig({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: join(dir, 'app.pem'), GITHUB_APP_INSTALLATION_ID: '9', FRIDAY_GITHUB_REPOS: 'org/a' } as NodeJS.ProcessEnv)!
    const gh = fakeGitHub()
    const id = new GitHubIdentity(cfg, log, gh.http)
    expect(id.mode).toBe('app')
    expect(await id.token()).toBe('ghs_tok1')
    expect(await id.token()).toBe('ghs_tok1')
    expect(gh.calls.filter((c) => c.path.endsWith('/access_tokens'))).toHaveLength(1)
    expect(gh.calls.find((c) => c.path.endsWith('/access_tokens'))?.auth?.startsWith('Bearer eyJ')).toBe(true)
    // 装在别的账号上的仓库：按 owner 换那份 installation 的 token
    expect(await id.token('someone')).toBe('ghs_tok2')
    expect(gh.calls.filter((c) => c.path === '/app/installations/77/access_tokens')).toHaveLength(1)
    expect(await id.token('unknown-owner')).toBe('ghs_tok1') // 没装的 owner 退回配置里的 installation
    expect(await id.botLogin()).toBe('friday-bot[bot]')
    expect(await id.describe()).toContain('安装在 2 个账号')
    expect(id.repoAllowed('org/a')).toBe(true)
    expect(id.repoAllowed('org/b')).toBe(false)
    const pat = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'ghp_x' } as NodeJS.ProcessEnv)!, log, gh.http)
    expect(pat.mode).toBe('pat')
    expect(await pat.token()).toBe('ghp_x')
    expect(loadGitHubConfig({} as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it('exposes read-only issue tools through the internal API, resolving "me" from the feishu→github map', async () => {
    const registry = new Registry(':memory:')
    const gh = fakeGitHub()
    const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'ghp_x', FRIDAY_GITHUB_REPOS: 'org/a' } as NodeJS.ProcessEnv)!, log, gh.http)
    const feishu = new FakeFeishu()
    const messageCache = new MessageCache(registry.db)
    const api = createInternalApi({ feishu: asFeishuClient(feishu), memory: new ChannelMemory(registry.db), registry, messages: new MessageService(asFeishuClient(feishu), messageCache, log), messageCache, todos: new Todos(registry.db), ...spaceDeps(registry.db), github, tokens: new TokenIssuer('s'), log, maxHistoryPerCall: 50 })
    const cap = { sessionKey: 'dm:ou_alice', chatId: 'oc_dm', chatType: 'p2p' as const, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 0 }
    // 不知道他是谁就拒绝（不能拿别人的 issue 充数），并且把下一步指向"问他一句"——
    // 不是指向一个他多半不知道的斜杠命令。
    await expect(api.routes['POST /v1/github/issues']!(cap, { assignee: 'me' })).rejects.toThrow(/问他/)
    await expect(api.routes['POST /v1/github/issues']!(cap, { assignee: 'me' })).rejects.not.toThrow(/发\s*\/github/)
    registry.setKv('github_login:ou_alice', 'ZhixingLu')
    const r = (await api.routes['POST /v1/github/issues']!(cap, { repo: 'org/a', assignee: 'me', type: 'issue' })) as { query: string; items: { number: number; repo: string; assignees: string[] }[] }
    expect(r.query).toBe('repo:org/a is:issue state:open assignee:ZhixingLu')
    expect(r.items[0]).toMatchObject({ number: 42, repo: 'org/a', assignees: ['ZhixingLu'] })
    await expect(api.routes['POST /v1/github/issues']!(cap, { repo: 'org/b' })).rejects.toThrow(/允许范围/)
    const one = (await api.routes['POST /v1/github/issue']!(cap, { repo: 'https://github.com/org/a', number: 42 })) as { title: string; comments: { author?: string }[] }
    expect(one.title).toBe('登录报错')
    expect(one.comments[0]?.author).toBe('bob')
    await expect(api.routes['POST /v1/github/issue']!(cap, { repo: 'org/a', number: 7 })).rejects.toThrow(/Not Found/)
    const me = (await api.routes['POST /v1/github/me']!(cap, {})) as { login: string | null; mode: string }
    expect(me).toMatchObject({ login: 'ZhixingLu', mode: 'pat' })
    // 模型永远拿不到 token：内部 API 的响应里不含它
    expect(JSON.stringify(r)).not.toContain('ghp_x')
  })

  it('开 Issue：当前委托 → 查重 → 写 → 回读；同一件事只开一张且不二次确认', async () => {
    const registry = new Registry(':memory:')
    const gh = fakeGitHub()
    const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'ghp_x', FRIDAY_GITHUB_REPOS: 'org/a', FRIDAY_GITHUB_WRITE_REPOS: 'org/a' } as NodeJS.ProcessEnv)!, log, gh.http)
    const feishu = new FakeFeishu()
    const messageCache = new MessageCache(registry.db)
    const asked: { header: string; headline: string; note?: string }[] = []
    const issueLinks = new IssueLinks(registry.db)
    const api = createInternalApi({
      feishu: asFeishuClient(feishu),
      memory: new ChannelMemory(registry.db),
      registry,
      messages: new MessageService(asFeishuClient(feishu), messageCache, log),
      messageCache,
      todos: new Todos(registry.db),
      ...spaceDeps(registry.db),
      github,
      issueLinks,
      botName: 'Friday',
      confirm: async (i) => {
        asked.push(i)
        return false
      },
      tokens: new TokenIssuer('s'),
      log,
      maxHistoryPerCall: 50,
    })
    const cap = { sessionKey: 'msg:1', chatId: 'oc_g', chatType: 'group' as const, requesterOpenId: 'ou_alice', scopes: [...ALL_SCOPES], exp: 0 }

    const r = (await api.routes['POST /v1/github/issue/open']!(cap, { title: '登录页在 Safari 上白屏', body: '复现：打开登录页，白屏。期望：正常渲染。' })) as {
      action: string
      number: number
      url: string
      pending: string[]
    }
    expect(r).toMatchObject({ action: 'created', number: 101, url: 'https://github.com/org/a/issues/101' })
    // 没指派就如实说，不替人做决定
    expect(r.pending.join()).toContain('负责人没填')
    expect(asked).toEqual([])
    // 正文带了出处，且没有泄漏 token
    const created = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/org/a/issues')!
    expect(JSON.stringify(created.body)).toContain('由 Friday 从群')
    expect(JSON.stringify(r)).not.toContain('ghp_x')
    // 写后回读过
    expect(gh.calls.filter((c) => c.method === 'GET' && c.path === '/repos/org/a/issues/101')).toHaveLength(1)

    // HTTP/模型重试同一意图：追加的出处时间戳变化也不能把它变成新评论。
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
      const replay = await api.routes['POST /v1/github/issue/open']!(cap, {
        title: '登录页在 Safari 上白屏', body: '复现：打开登录页，白屏。期望：正常渲染。',
        requestKey: 'model-chosen-key-is-ignored',
      })
      expect(replay).toMatchObject({ action: 'created', number: 101, replayed: true })
      expect(gh.calls.filter((c) => c.method === 'POST' && c.path.includes('/comments'))).toHaveLength(0)
    } finally { clock.mockRestore() }

    // 同一件事再来一次：不新建，改成补评论
    const again = (await api.routes['POST /v1/github/issue/open']!(cap, { title: '登录页在 Safari 上 白屏！', body: '又有人遇到了' })) as { action: string; number: number }
    expect(again).toMatchObject({ action: 'commented', number: 101 })
    expect(gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/org/a/issues')).toHaveLength(1)
    expect(asked).toEqual([])

    // 指纹只按"空间 + 仓库 + 标题"算，标点和大小写不影响
    expect(fingerprintOf({ spaceId: 's', repo: 'org/a', title: 'A B!' })).toBe(fingerprintOf({ spaceId: 's', repo: 'org/a', title: 'a  b' }))
    expect(fingerprintOf({ spaceId: 's1', repo: 'org/a', title: 'x' })).not.toBe(fingerprintOf({ spaceId: 's2', repo: 'org/a', title: 'x' }))

    // 留言：只追加，不改正文
    const c = (await api.routes['POST /v1/github/issue/comment']!(cap, { number: 42, body: '群里确认是缓存问题' })) as { commentUrl: string }
    expect(c.commentUrl).toContain('issuecomment-9')
    const commentReplay = await api.routes['POST /v1/github/issue/comment']!(cap, { number: 42, body: '群里确认是缓存问题', requestKey: 'another-model-key' })
    expect(commentReplay).toMatchObject({ commentUrl: c.commentUrl, replayed: true })
    expect(gh.calls.filter((x) => x.method === 'POST' && x.path === '/repos/org/a/issues/42/comments')).toHaveLength(1)
    expect(gh.calls.some((x) => x.method === 'PATCH')).toBe(false)
    expect(asked).toEqual([])

    // 仓库白名单照旧
    await expect(api.routes['POST /v1/github/issue/open']!(cap, { repo: 'org/b', title: 'x'.repeat(10), body: 'y'.repeat(20) })).rejects.toThrow(/只读：它不在可写仓库名单/)
  })
})

describe('用哪个身份读 GitHub', () => {
  const app = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GITHUB_APP_INSTALLATION_ID: '9' } as NodeJS.ProcessEnv

  it('三件套齐了默认走 App', () => {
    expect(loadGitHubConfig({ ...app } as NodeJS.ProcessEnv)?.mode).toBeUndefined()
  })

  it('GITHUB_AUTH_MODE=pat 能一行切过去，不用注释掉三行 APP 配置', () => {
    const c = loadGitHubConfig({ ...app, GITHUB_TOKEN: 'ghp_x', GITHUB_AUTH_MODE: 'pat' } as NodeJS.ProcessEnv)!
    expect(c.mode).toBe('pat')
    expect(c.appId).toBe('1') // App 配置留着，随时切回来
    expect(c.token).toBe('ghp_x')
  })

  it('没给 token 就算写了 pat 也不会把自己弄成没身份', () => {
    const c = loadGitHubConfig({ ...app, GITHUB_AUTH_MODE: 'pat' } as NodeJS.ProcessEnv)!
    expect(c.mode).toBe('pat')
    expect(c.token).toBeUndefined()
    // 实际取模式时会因为没有 token 退回 app（见 identity.mode）
  })

  it('乱写的 mode 当没写', () => {
    expect(loadGitHubConfig({ ...app, GITHUB_AUTH_MODE: 'banana' } as NodeJS.ProcessEnv)?.mode).toBeUndefined()
  })
})
