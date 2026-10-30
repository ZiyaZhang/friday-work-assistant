import { AsyncLocalStorage } from 'node:async_hooks'
import { GitHubApiError, type GitHubIdentity } from './identity.js'
import type { GitHubUserConnections } from './user-connection.js'

const PERSONAL_READS = new Set(['issues', 'issue', 'releases', 'pr/checks', 'pr/check-evidence', 'pr/diff', 'me', 'login'])
interface Actor { chatType: string; requesterOpenId?: string }

/** Request-local identity also covers helpers nested several calls below a route.
 * Team checkout/project services have their own clients, so they are not admitted
 * into the personal lane until they support an owner-bound connection themselves. */
export function personalGitHubLane(team: GitHubIdentity | undefined, personal?: GitHubUserConnections) {
  const context = new AsyncLocalStorage<{ owner: string; reader?: GitHubIdentity; revision?: number }>()
  const github = !team && !personal ? undefined : new Proxy({} as GitHubIdentity, { get: (_target, name) => {
    const lane = context.getStore()
    if (lane && personal && !lane.reader) {
      lane.revision = personal.view(lane.owner).revision
      lane.reader = personal.reader(lane.owner)
    }
    const identity = lane?.reader ?? team
    if (!identity) throw new GitHubApiError(503, 'GitHub 尚未连接。')
    const value = Reflect.get(identity, name, identity)
    return typeof value === 'function' ? value.bind(identity) : value
  } })
  async function run<T>(route: string, actor: Actor, perform: () => Promise<T>): Promise<T> {
    if (!personal || actor.chatType !== 'p2p') return perform()
    if (!actor.requesterOpenId) throw new GitHubApiError(403, '缺少本人身份。')
    const suffix = route.replace(/^POST \/v1\/github\//, '')
    if (route.startsWith('POST /v1/github/') && !PERSONAL_READS.has(suffix) ||
      /^POST \/v1\/(?:project|repository)\//.test(route)) throw new GitHubApiError(403, '个人 GitHub 目前支持读取、评审准备和回复草稿；此操作尚未接入本人账号。')
    const lane: { owner: string; reader?: GitHubIdentity; revision?: number } = { owner: actor.requesterOpenId }
    return context.run(lane, async () => {
      const result = await perform()
      if (lane.revision !== undefined) personal.assertCurrent(lane.owner, lane.revision)
      return result
    })
  }
  return { github, run, receipt: () => {
    const lane = context.getStore()
    return lane?.revision === undefined ? undefined : { owner: lane.owner, revision: lane.revision }
  } }
}
