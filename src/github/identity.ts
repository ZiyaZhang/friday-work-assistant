/**
 * GitHub 身份：照 Claude Tag / claude-code-action 的做法，Friday 以一个 GitHub App 的身份行动——
 * 网关用 App 私钥签 JWT，换 1 小时的 installation token；沙箱里的模型永远拿不到 token，
 * 只能调网关暴露的 github_* 工具（网关代它请求 api.github.com）。PR/评论的作者是 `<app>[bot]`。
 *
 * 过渡期没有 App 时可以用 GITHUB_TOKEN（个人 PAT）：能用，但所有动作都会显示成那个人做的，
 * 只建议用来跑通读接口，开 PR 前换成 App。
 *
 * 出网：开发机访问 api.github.com 要经代理，和飞书一样只挂在这里的 axios 实例上。
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Logger } from '../log.js'
import { githubRelay, GitHubTransport, type GitHubRelay } from './transport.js'
import { downloadActionsJobLog, type ActionsJobLogRequest, type ActionsJobLogBytes } from './job-log-download.js'
import { JOB_LOG_TIMEOUT_MS, GitHubJobLogError, validateJobLog } from './job-log-policy.js'

export interface GitHubConfig {
  apiUrl: string
  /** App 模式 */
  appId?: string
  privateKeyPath?: string
  installationId?: string
  /** PAT 模式（过渡） */
  token?: string
  /** 显式指定用哪种身份；不给就是「App 的三件套齐了就用 App」 */
  mode?: 'app' | 'pat'
  proxyUrl?: string
  relay?: GitHubRelay
  /** 允许读取的仓库（owner/repo），空 = 不限制；不授予写权限 */
  allowedRepos: string[]
  /** 显式可写仓库；空 = 禁止所有仓库写操作 */
  writableRepos: string[]
}

export function loadGitHubConfig(env: NodeJS.ProcessEnv = process.env): GitHubConfig | undefined {
  const relay = githubRelay(env.FRIDAY_GITHUB_RELAY_URL?.trim(), env.FRIDAY_GITHUB_RELAY_TOKEN)
  const appId = env.GITHUB_APP_ID?.trim()
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim()
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim()
  const token = env.GITHUB_TOKEN?.trim()
  const want = env.GITHUB_AUTH_MODE?.trim().toLowerCase()
  const mode = want === 'pat' || want === 'app' ? (want as 'app' | 'pat') : undefined
  if (!(appId && privateKeyPath && installationId) && !token) return undefined
  const proxy = env.FRIDAY_GITHUB_PROXY?.trim() ?? env.FRIDAY_FEISHU_PROXY?.trim()
  return {
    apiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    appId: appId || undefined,
    privateKeyPath: privateKeyPath || undefined,
    installationId: installationId || undefined,
    token: token || undefined,
    mode,
    proxyUrl: proxy && !['off', 'none', '0'].includes(proxy) ? proxy : undefined,
    ...(relay ? { relay } : {}),
    allowedRepos: (env.FRIDAY_GITHUB_REPOS ?? '').split(/[\s,]+/).filter(Boolean),
    // 读和写分开。读是"看一眼回答问题"，随便读；写会在别人的仓库里留下痕迹，范围该更窄。
    // 没配或留空都禁写，读取范围不能成为隐式写授权。
    writableRepos: (env.FRIDAY_GITHUB_WRITE_REPOS ?? '').split(/[\s,]+/).filter(Boolean),
  }
}

export interface GitHubHttp {
  readActionsJobLog?(input: ActionsJobLogRequest, authorization: string): Promise<ActionsJobLogBytes>
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; data: T }>
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

/** base64url 编码的 App JWT（RS256，10 分钟）。 */
export function signAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId })}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem, 'base64url')
  return `${unsigned}.${sig}`
}

interface InstallationInfo {
  id: string
  account: string
}

export class GitHubIdentity {
  /** 每个 installation 一份 token（个人账号装了一份、org 装了一份时各自换） */
  private readonly cached = new Map<string, { token: string; expiresAt: number }>()
  private installations?: { at: number; list: InstallationInfo[] }
  private botLoginCache?: string
  private readonly http: GitHubHttp
  readonly transport: GitHubTransport

  constructor(
    private readonly cfg: GitHubConfig,
    private readonly log: Logger,
    http?: GitHubHttp,
  ) {
    this.transport = new GitHubTransport(cfg.apiUrl, cfg.relay)
    this.http = http ?? makeHttp(cfg, this.transport)
  }

  get mode(): 'app' | 'pat' {
    // 显式指定优先。GitHub App 只能看到「装在哪个账号/组织下」的仓库——
    // 装在个人账号上就读不到公司组织的东西，而且报的是 Not Found，不是 403，
    // 很容易被当成「仓库不存在」。这时候换 PAT 是一行配置的事，
    // 不该逼人去把三行 GITHUB_APP_* 注释掉。
    if (this.cfg.mode === 'pat' && this.cfg.token) return 'pat'
    if (this.cfg.mode === 'app') return 'app'
    return this.cfg.appId && this.cfg.privateKeyPath && this.cfg.installationId ? 'app' : 'pat'
  }

  /** 能不能**读**这个仓库。读是回答问题用的，范围可以宽。 */
  repoAllowed(repo: string): boolean {
    return !this.cfg.allowedRepos.length || this.cfg.allowedRepos.some((r) => r.toLowerCase() === repo.toLowerCase())
  }

  /**
   * 能不能**往**这个仓库写（开 PR、推分支、开 Issue、评论）。
   *
   * 分开是因为两件事的后果不一样：读错了顶多答偏，写会在别人的仓库里留下痕迹，
   * 而且署的是 Friday 的 GitHub 身份。以前两者共用 `FRIDAY_GITHUB_REPOS`，
   * 意思就成了"凡是能读的都能写"——真实仓库和沙箱仓库同在一张表里时，这不是想要的。
   *
   * 必须显式列入写名单，且不能超出读取范围。空名单不授予任何写权限。
   */
  repoWritable(repo: string): boolean {
    return this.repoAllowed(repo) && (this.cfg.writableRepos ?? []).some((r) => r.toLowerCase() === repo.toLowerCase())
  }

  /** 只配了一个允许仓库时，写操作可以不写 repo（群里说"提个 issue"不该还要报仓库名）。 */
  defaultRepo(): string | undefined {
    return this.cfg.allowedRepos.length === 1 ? this.cfg.allowedRepos[0] : undefined
  }

  private appJwt(): string {
    const pem = readFileSync(this.cfg.privateKeyPath as string, 'utf8')
    return signAppJwt(this.cfg.appId as string, pem)
  }

  /**
   * App 装在哪些账号上（个人 / org）。org 的安装申请被批准后这里会自动出现，不用改配置。
   * 缓存 10 分钟；失败时退回配置里的 GITHUB_APP_INSTALLATION_ID。
   */
  async listInstallations(signal?: AbortSignal): Promise<InstallationInfo[]> {
    signal?.throwIfAborted()
    if (this.mode !== 'app') return []
    if (this.installations && Date.now() - this.installations.at < 10 * 60_000) return this.installations.list
    try {
      const res = await this.http.request<{ id: number; account?: { login?: string } }[]>('GET', '/app/installations?per_page=100', undefined, { authorization: `Bearer ${this.appJwt()}` }, signal)
      signal?.throwIfAborted()
      if (res.status >= 300 || !Array.isArray(res.data)) throw new GitHubApiError(res.status, '列 installations 失败')
      this.installations = { at: Date.now(), list: res.data.map((i) => ({ id: String(i.id), account: i.account?.login ?? '' })) }
    } catch (err) {
      signal?.throwIfAborted()
      this.log.warn('list installations failed, using configured installation id', { err: String(err) })
      this.installations = { at: Date.now(), list: this.cfg.installationId ? [{ id: this.cfg.installationId, account: '' }] : [] }
    }
    return this.installations.list
  }

  /** 某个仓库 owner 对应的 installation：装在那个账号上的优先，否则用配置里的那份。 */
  async installationFor(owner?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (owner) {
      const hit = (await this.listInstallations(signal)).find((i) => i.account.toLowerCase() === owner.toLowerCase())
      signal?.throwIfAborted()
      if (hit) return hit.id
    }
    if (this.cfg.installationId) return this.cfg.installationId
    const first = (await this.listInstallations(signal))[0]
    signal?.throwIfAborted()
    if (first) return first.id
    throw new GitHubApiError(404, `App 没有安装在 ${owner ?? '任何账号'} 上（org 的安装申请可能还没被批准）`)
  }

  /** 当前可用的 token（App 模式下按 owner 选 installation 并自动续；PAT 模式原样返回）。 */
  async token(owner?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (this.mode === 'pat') return this.cfg.token as string
    const installationId = await this.installationFor(owner, signal)
    signal?.throwIfAborted()
    const cached = this.cached.get(installationId)
    if (cached && cached.expiresAt > Date.now() + 10 * 60_000) return cached.token
    const res = await this.http.request<{ token?: string; expires_at?: string; message?: string }>('POST', `/app/installations/${installationId}/access_tokens`, {}, { authorization: `Bearer ${this.appJwt()}` }, signal)
    signal?.throwIfAborted()
    if (res.status >= 300 || !res.data.token) throw new GitHubApiError(res.status, res.data.message ?? '换 installation token 失败')
    const entry = { token: res.data.token, expiresAt: res.data.expires_at ? Date.parse(res.data.expires_at) : Date.now() + 55 * 60_000 }
    this.cached.set(installationId, entry)
    this.log.info('github installation token minted', { installationId, expiresAt: new Date(entry.expiresAt).toISOString() })
    return entry.token
  }

  /** 以当前身份调 GitHub REST：路径必须以 / 开头；4xx/5xx 抛错。/repos/<owner>/… 的路径自动按 owner 选 installation。 */
  async api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, owner?: string, beforeRequest?: () => void, signal?: AbortSignal): Promise<T> {
    const inferred = owner ?? path.match(/^\/repos\/([^/]+)\//)?.[1]
    const token = await this.token(inferred, signal)
    signal?.throwIfAborted()
    // 授权可能在安装令牌刷新期间撤销；同步检查后立即开始 HTTP，不把它当作远端结果未知。
    beforeRequest?.()
    const res = await this.http.request<T & { message?: string }>(method, path, body, { authorization: `Bearer ${token}` }, signal)
    if (res.status >= 300) throw new GitHubApiError(res.status, (res.data as { message?: string })?.message ?? `GitHub ${method} ${path} → HTTP ${res.status}`)
    return res.data
  }

  async readActionsJobLog(input: ActionsJobLogRequest): Promise<ActionsJobLogBytes> {
    validateJobLog(input.repo, input.jobId, input.maxBytes, input.startByte)
    const deadline = AbortSignal.timeout(JOB_LOG_TIMEOUT_MS)
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), deadline])
    const assertCurrent = () => {
      signal.throwIfAborted(); input.assertCurrent()
      if (!this.repoAllowed(input.repo)) throw new GitHubJobLogError('repository_denied')
    }
    assertCurrent()
    if (!this.http.readActionsJobLog) throw new GitHubJobLogError('unavailable')
    try {
      const token = await this.token(input.repo.split('/')[0], signal)
      assertCurrent()
      const result = await this.http.readActionsJobLog({ ...input, signal, assertCurrent }, `Bearer ${token}`)
      assertCurrent()
      return result
    } catch (error) {
      // A provider deadline is a partial-evidence failure. An actual caller
      // stop or revoked source remains an authority error and discards output.
      input.signal?.throwIfAborted(); input.assertCurrent()
      if (!this.repoAllowed(input.repo)) throw new GitHubJobLogError('repository_denied')
      if (deadline.aborted && (error === deadline.reason || axios.isCancel(error))) throw new GitHubJobLogError('unavailable')
      throw error
    }
  }

  /** 机器人的登录名：App 模式是 `<slug>[bot]`；PAT 模式是 token 主人。 */
  async botLogin(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (this.botLoginCache) return this.botLoginCache
    if (this.mode === 'app') {
      const res = await this.http.request<{ slug?: string; message?: string }>('GET', '/app', undefined, { authorization: `Bearer ${this.appJwt()}` }, signal)
      signal?.throwIfAborted()
      if (res.status >= 300 || !res.data.slug) throw new GitHubApiError(res.status, res.data.message ?? '读不到 App 信息')
      this.botLoginCache = `${res.data.slug}[bot]`
    } else {
      const me = await this.api<{ login: string }>('GET', '/user', undefined, undefined, undefined, signal)
      signal?.throwIfAborted()
      this.botLoginCache = me.login
    }
    return this.botLoginCache
  }

  /** 提交作者：<slug>[bot] + GitHub 的 noreply 邮箱（带用户 id 才能在 GitHub 上正确归属）。 */
  async botAuthor(signal?: AbortSignal): Promise<{ name: string; email: string }> {
    const login = await this.botLogin(signal)
    let id: number | undefined
    try {
      const u = await this.api<{ id?: number }>('GET', `/users/${encodeURIComponent(login)}`, undefined, undefined, undefined, signal)
      signal?.throwIfAborted()
      id = u.id
    } catch {
      signal?.throwIfAborted()
      id = undefined
    }
    return { name: login, email: `${id ? `${id}+` : ''}${login}@users.noreply.github.com` }
  }

  /** 体检：身份可用 + 装在哪些账号、能看到哪些仓库。 */
  async describe(): Promise<string> {
    const login = await this.botLogin()
    if (this.mode === 'app') {
      const parts: string[] = []
      for (const inst of await this.listInstallations()) {
        const token = await this.token(inst.account || undefined)
        const r = await this.http.request<{ total_count?: number; repositories?: { full_name: string }[] }>('GET', '/installation/repositories?per_page=5', undefined, { authorization: `Bearer ${token}` })
        const names = (r.data.repositories ?? []).map((x) => x.full_name)
        parts.push(`${inst.account || inst.id}：${r.data.total_count ?? names.length} 个仓库${names.length ? `（${names.join(', ')}${(r.data.total_count ?? 0) > names.length ? '…' : ''}）` : ''}`)
      }
      return `App 身份 ${login}，安装在 ${parts.length} 个账号 → ${parts.join('；') || '（还没有任何安装）'}`
    }
    return `个人 token（${login}）——所有操作会显示为这个人做的，开 PR 前请换成 GitHub App`
  }
}

function makeHttp(cfg: GitHubConfig, transport: GitHubTransport): GitHubHttp {
  const agent = cfg.proxyUrl ? new HttpsProxyAgent(cfg.proxyUrl, { keepAlive: true }) : undefined
  const inst = axios.create({ ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}), validateStatus: () => true, timeout: 30_000, maxRedirects: 0 })
  return {
    readActionsJobLog: (input, authorization) => downloadActionsJobLog(inst, transport, input, authorization),
    async request(method, path, body, headers = {}, signal) {
      const target = transport.api(path)
      const res = await inst.request({
        method,
        url: target.url,
        data: body,
        signal,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'friday-github', ...headers, ...target.headers },
      })
      const data = typeof res.data === 'string' ? safeJson(res.data) : (res.data ?? {})
      return { status: res.status, data: data as never }
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { message: text.slice(0, 200) }
  }
}
