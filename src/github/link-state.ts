import type { GitHubItemState, GitHubRef } from '../core/todo-completion-evidence.js'
import type { GitHubIdentity } from './identity.js'

/**
 * 待办里写的 Issue / PR 链接现在是什么状态。待办完成证据和 PMO「关联」列共用。
 *
 * 只发 GET（Issue 一次；是 PR 再读一次合并状态），不读正文；只读 FRIDAY_GITHUB_REPOS 允许的仓库。
 * 读不到（不在允许范围、接口出错、请求前的核验不再成立）一律按读不到返回，不抛错，也不当成没做完。
 */
export async function readGitHubLinkState(github: Pick<GitHubIdentity, 'api' | 'repoAllowed'>, ref: GitHubRef,
  beforeRequest?: () => void): Promise<GitHubItemState> {
  const match = `${ref.owner}/${ref.repo}`.trim().replace(/\.git$/, '').match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/)
  const repo = match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
  if (!repo || !github.repoAllowed(repo)) return { status: 'unavailable', reason: '仓库不在允许范围内' }
  try {
    const issue = await github.api<Record<string, unknown>>('GET', `/repos/${repo}/issues/${ref.number}`, undefined, undefined, beforeRequest)
    const pull = issue.pull_request
      ? await github.api<Record<string, unknown>>('GET', `/repos/${repo}/pulls/${ref.number}`, undefined, undefined, beforeRequest) : undefined
    return { status: 'read', kind: pull ? 'pull' : 'issue', state: issue.state === 'closed' ? 'closed' : 'open',
      merged: pull?.merged === true, stateReason: typeof issue.state_reason === 'string' ? issue.state_reason : null }
  } catch (err) {
    return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
}
