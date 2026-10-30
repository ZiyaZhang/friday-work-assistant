import type { Registry } from '../core/registry.js'
import type { ExecutionSourceAccessResult } from '../core/execution-source-access.js'
import type { MaterialProvenance } from '../core/execution-materials.js'
import type { RetainedSourceOrigin } from '../core/retained-source-access.js'
import type { IssueOperationOrigin } from './issues.js'

export interface IssueDeliverable {
  kind: 'issue' | 'pull_request'; repo: string; number: number; url: string
  assertCurrent(): void
}

/** Project the existing ACK ledger, not chat adjacency or a new ownership store.
 * An identity helps classification only; it grants neither content nor writes. */
export async function issueDeliverablesForWork(deps: {
  registry: Registry; workKey: string; sessionKey: string; actorOpenId: string
  repoAllowed(repo: string): boolean
  authorizeSaved(provenance: MaterialProvenance, origin: RetainedSourceOrigin, guard: () => void): Promise<ExecutionSourceAccessResult>
  assertCurrent(): void
}): Promise<IssueDeliverable[]> {
  const { registry } = deps
  deps.assertCurrent()
  // The Issue writer owns additive schema initialization. Old deployments or
  // legacy rows cannot acquire a Run identity by later inference.
  if (!registry.db.prepare('PRAGMA table_info(github_issue_operations)').all().some(row => row.name === 'origin_json')) return []
  const rows = registry.db.prepare(`SELECT request_key,repo,number,url,comment_url,origin_json FROM github_issue_operations
    WHERE json_extract(origin_json,'$.origin.workKey')=? AND status IN ('sent','confirmed')
    ORDER BY created_at DESC,rowid DESC LIMIT 24`).all(deps.workKey)
  const results = new Map<string, IssueDeliverable>()
  for (const row of rows) {
    let saved: IssueOperationOrigin
    try { saved = JSON.parse(String(row.origin_json)) as IssueOperationOrigin } catch { continue }
    if (saved?.version !== 1 || !saved.apiCallId || !saved.origin || !saved.provenance?.sources || !Array.isArray(saved.provenance.memoryRefs)) continue
    const repo = String(row.repo).toLowerCase(), number = Number(row.number)
    const identity = parseIdentity(repo, number, String(row.url || row.comment_url || ''))
    // Several writes to one Issue share one identity: authorize it once, not once per row.
    if (!identity || results.has(identity.url)) continue
    const origin = saved.origin
    const current = () => {
      deps.assertCurrent()
      const operation = registry.db.prepare('SELECT status,origin_json,repo,number,url,comment_url FROM github_issue_operations WHERE request_key=?').get(row.request_key!)
      const call = registry.db.prepare('SELECT run_id,route,scopes_json FROM run_api_calls WHERE id=?').get(saved.apiCallId)
      const run = registry.db.prepare('SELECT task_id,session_key,work_key,actor_open_id,acp_session_id,stage FROM run_attempts WHERE id=?').get(origin.runId)
      const task = registry.getTask(origin.taskId), work = registry.taskWork.get(origin.taskId)
      if (origin.workKey !== deps.workKey || origin.sessionKey !== deps.sessionKey || origin.ownerOpenId !== deps.actorOpenId ||
        !operation || !['sent','confirmed'].includes(String(operation.status)) || operation.origin_json !== row.origin_json ||
        operation.repo !== row.repo || operation.number !== row.number || operation.url !== row.url || operation.comment_url !== row.comment_url ||
        !call || call.run_id !== origin.runId || !['POST /v1/github/issue/open','POST /v1/github/issue/comment'].includes(String(call.route)) ||
        !JSON.parse(String(call.scopes_json)).includes('github:write') || !run || run.stage !== 'task' || run.task_id !== origin.taskId ||
        run.session_key !== origin.sessionKey || run.work_key !== origin.workKey || run.actor_open_id !== origin.ownerOpenId ||
        run.acp_session_id !== saved.provenance.sources.acpSessionId || !task || task.sessionKey !== origin.sessionKey ||
        task.requesterOpenId !== origin.ownerOpenId || work?.key !== origin.workKey ||
        saved.provenance.sources.spaceId !== origin.spaceId || saved.provenance.sources.chatId !== origin.chatId || !deps.repoAllowed(repo)) {
        throw new Error('Issue 来源关联已变化')
      }
    }
    try {
      current()
      const access = await deps.authorizeSaved(saved.provenance, origin, current)
      current(); access.assertCurrent()
      if (access.status !== 'allowed') continue
      results.set(identity.url, { ...identity, assertCurrent: () => { current(); access.assertCurrent() } })
      if (results.size === 3) break
    } catch {
      // Optional identities with unavailable/changed original authority are
      // omitted. The outer routing lease is never swallowed.
      deps.assertCurrent()
    }
  }
  deps.assertCurrent()
  return [...results.values()]
}

function parseIdentity(repo: string, number: number, raw: string): Omit<IssueDeliverable, 'assertCurrent'> | undefined {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search ||
      url.hash && !/^#issuecomment-[1-9]\d*$/.test(url.hash)) return undefined
    const match = /^\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)$/.exec(url.pathname)
    if (!match || match[1]!.toLowerCase() !== repo || Number(match[3]) !== number) return undefined
    return { repo, number, kind: match[2] === 'issues' ? 'issue' : 'pull_request', url: `https://github.com/${repo}/${match[2]}/${number}` }
  } catch { return undefined }
}
