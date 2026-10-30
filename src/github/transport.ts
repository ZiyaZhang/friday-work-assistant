import { validateJobLog } from './job-log-policy.js'

export interface GitHubRelay { url: string; token: string }
export function githubRelay(url?: string, token?: string): GitHubRelay | undefined {
  if (!url && !token) return undefined
  if (!url || !token) throw new Error('FRIDAY_GITHUB_RELAY_URL 和 FRIDAY_GITHUB_RELAY_TOKEN 必须成对配置')
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('GitHub 中转凭据至少 32 字符且不能含换行')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('GitHub 中转地址无效') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== '/') throw new Error('GitHub 中转必须使用不含路径、账号或参数的 HTTPS origin')
  return { url: parsed.origin, token }
}

/** Routing is chosen before a request starts. A failed relay never selects a
 * second transport; the business operation retains its existing unknown ledger. */
export class GitHubTransport {
  readonly relay?: GitHubRelay
  constructor(private readonly apiUrl = 'https://api.github.com', relay?: GitHubRelay) {
    this.relay = githubRelay(relay?.url, relay?.token)
  }
  api(path: string): { url: string; headers: Record<string,string> } {
    // Model/provider URLs cannot change the authority to which GitHub credentials go.
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\#]/.test(path)) throw new Error('GitHub API 路径必须是相对 API 路径')
    const base = this.relay ? `${this.relay.url}/api` : this.apiUrl.replace(/\/$/,'')
    const url = new URL(base + path)
    if (url.href !== base + path) throw new Error('GitHub API 路径不能改变已配置的目标')
    return { url:url.href, headers:this.relay ? {'x-friday-relay-token':this.relay.token} : {} }
  }
  jobLog(repo: string, jobId: number, maxBytes: number, startByte?: number): { url: string; headers: Record<string, string> } {
    validateJobLog(repo, jobId, maxBytes, startByte)
    if (!this.relay) return this.api(`/repos/${repo}/actions/jobs/${jobId}/logs`)
    return { url: `${this.relay.url}/logs/${repo}/${jobId}`, headers: {
      'x-friday-relay-token': this.relay.token, 'x-friday-log-max-bytes': String(maxBytes),
      ...(startByte !== undefined ? { 'x-friday-log-start-byte': String(startByte) } : {}),
    } }
  }
  directGit(repo: string): string { this.requireRepo(repo); return `https://github.com/${repo}.git` }
  gitRemote(repo: string): string {
    this.requireRepo(repo)
    return this.relay ? `${this.relay.url}/git/${repo}.git` : this.directGit(repo)
  }
  gitRequest(repo: string, registeredRemote = this.gitRemote(repo)): { url:string; headers:Record<string,string> } {
    if (registeredRemote !== this.directGit(repo) && registeredRemote !== this.gitRemote(repo)) throw new Error('GitHub 修改副本的登记远端不属于当前传输配置')
    // Existing direct bindings remain unchanged. Only the host's actual network
    // request is routed through the configured relay, including ls-remote/push.
    return {url:this.gitRemote(repo),headers:this.relay ? {'x-friday-relay-token':this.relay.token} : {}}
  }
  private requireRepo(repo:string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part=>part==='.'||part==='..')) throw new Error('GitHub 仓库必须是 owner/name')
  }
}
