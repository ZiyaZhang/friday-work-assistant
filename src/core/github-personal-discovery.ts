import type { Registry } from './registry.js'
import type { TodoAudience, Todos } from './todos.js'
import type { TodoProvenance } from './todo-provenance.js'
import { TodoApplication } from './todo-application.js'
import type { GitHubUserConnections } from '../github/user-connection.js'

export interface GitHubDiscoveryView { revision: number; checkedAt: number; attemptedAt?: number; partial: boolean; state: 'current' | 'retrying' | 'needs_installation';
  waiting: { title: string; url: string; draft: boolean }[] }
const TTL = 5 * 60_000
/** Bounded, owner-authorized search. An absent search result never closes a task. */
export class GitHubPersonalDiscovery {
  private busy = false
  constructor(private readonly d: { registry: Registry; todos: Todos; connections: GitHubUserConnections; now(): number
    enabled(owner: string): boolean; audience(owner: string): TodoAudience; onChange(owner: string): Promise<void> }) {}
  view(owner: string): GitHubDiscoveryView | undefined {
    const raw = this.d.registry.getKv(`github-discovery:${owner}`)
    const view = raw ? JSON.parse(raw) as GitHubDiscoveryView : undefined
    const grant = this.d.connections.view(owner)
    return grant.status === 'connected' && view?.revision === grant.revision ? view : undefined
  }
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const owners = this.d.registry.db.prepare("SELECT owner FROM github_user_connections WHERE status='connected'").all().map(r => String(r.owner))
        .filter(owner => this.d.enabled(owner)).sort((a, b) => (this.view(a)?.attemptedAt ?? this.view(a)?.checkedAt ?? 0) - (this.view(b)?.attemptedAt ?? this.view(b)?.checkedAt ?? 0))
      for (const owner of owners.slice(0, 3)) if (this.d.now() - (this.view(owner)?.attemptedAt ?? this.view(owner)?.checkedAt ?? 0) >= TTL) {
        try { await this.refresh(owner) } catch { /* No provider responses or credentials in logs. Next tick retries. */ }
      }
    } finally { this.busy = false }
  }
  async refresh(owner: string): Promise<void> {
    if (!this.d.enabled(owner)) return
    const grant = this.d.connections.view(owner), github = this.d.connections.reader(owner), audience = this.d.audience(owner)
    const guard = () => { this.d.connections.assertCurrent(owner, grant.revision)
      if (!this.d.enabled(owner) || this.d.audience(owner).chatId !== audience.chatId) throw new Error('Personal collection changed') }
    const prior = this.view(owner), waiting: GitHubDiscoveryView['waiting'] = []
    const existing = this.d.todos.listForAudience(audience, { status: 'all', limit: 1000 }).items.map(todo => ({ todo, source: this.d.todos.getProvenance(todo.id) }))
    let partial = false
    try {
      if (grant.method !== 'personal_token') {
        const installations = await github.api<{ total_count: number }>('GET', '/user/installations?per_page=1', undefined, undefined, guard)
        guard()
        if (!Number.isSafeInteger(installations.total_count)) throw new Error('Invalid GitHub installations')
        if (!installations.total_count && !this.d.connections.temporaryAccess(owner)) {
          this.d.registry.setKv(`github-discovery:${owner}`, JSON.stringify({ revision: grant.revision, checkedAt: this.d.now(), partial: false, waiting: [], state: 'needs_installation' }))
          return
        }
      }
      for (const kind of ['review_requested', 'assigned', 'authored'] as const) {
        const q = kind === 'review_requested' ? `is:open is:pr review-requested:${grant.login}` : kind === 'assigned' ? `is:open is:issue assignee:${grant.login}` : `is:open is:pr author:${grant.login}`
        const result = await github.api<{ total_count: number; incomplete_results: boolean; items: Record<string, unknown>[] }>('GET', `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`, undefined, undefined, guard)
        guard()
        if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total_count)) throw new Error('Invalid GitHub result')
        partial ||= result.incomplete_results === true || result.total_count > result.items.length
        for (const item of result.items) {
          const url = String(item.html_url ?? ''), match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9]\d*)$/)
          if (!match || item.state !== 'open' || typeof item.title !== 'string' || !item.title.trim() || !Number.isFinite(Date.parse(String(item.updated_at)))) { partial = true; continue }
          if (kind === 'authored') {
            const author = item.user as { login?: string } | undefined
            if (author?.login?.toLowerCase() !== grant.login?.toLowerCase() || match[2] !== 'pull') { partial = true; continue }
            waiting.push({ title: item.title.slice(0, 200), url, draft: item.draft === true }); continue
          }
          if (kind === 'assigned' && (!Array.isArray(item.assignees) || !item.assignees.some(a => typeof a?.login === 'string' && a.login.toLowerCase() === grant.login?.toLowerCase()) || match[2] !== 'issues')) { partial = true; continue }
          if (kind === 'review_requested' && (match[2] !== 'pull' || item.draft === true)) continue
          guard()
          // The Feishu collector may already own this work; preserve its richer context and all manual corrections.
          const found = existing.find(({ todo, source: p }) => {
            return p?.github?.url === url || p?.collection?.github?.url === url ||
              p?.collection?.quote.includes(url) && (kind === 'review_requested' ? /评审|review|审查/i.test(todo.title) : /处理|解决|修复|实现/i.test(todo.title))
          })
          if (found) continue
          const repo = match[1]!, source: TodoProvenance = { version: 1, originRunId: `github-discovery:${owner}:${grant.revision}`,
            workKey: `github:${url}`, taskId: null, request: null, selectedInputs: [],
            github: { ownerOpenId: owner, revision: grant.revision, accountId: grant.accountId!, login: grant.login!, url,
              completion: kind === 'review_requested' ? 'reviewed' : 'issue_closed', relationship: kind, updatedAt: Date.parse(String(item.updated_at)) },
            contextSnapshot: { version: 1, acpSessionId: `github-discovery:${owner}:${grant.revision}`, spaceId: `sp_dm_${owner}`,
              chatId: audience.chatId!, memoryScopes: [], chats: [], external: [], repositories: [repo.toLowerCase()],
              personalRepositories: [{ repo: repo.toLowerCase(), owner, revision: grant.revision }] } }
          const created = new TodoApplication({ db: this.d.registry.db, todos: this.d.todos }).create(audience, { title: `${kind === 'review_requested' ? '评审' : '处理'} ${item.title.slice(0, 200)} #${match[3]}`,
            kind: 'todo', ownerOpenId: owner, confirmed: false, source: url, provenance: source }, owner)
          existing.push({ todo: created.todo, source })
        }
      }
      guard()
      this.d.registry.setKv(`github-discovery:${owner}`, JSON.stringify({ revision: grant.revision, checkedAt: this.d.now(), partial, waiting, state: 'current' }))
    } catch (error) {
      guard()
      this.d.registry.setKv(`github-discovery:${owner}`, JSON.stringify({ revision: grant.revision, checkedAt: prior?.checkedAt ?? 0, attemptedAt: this.d.now(), partial: true, waiting: prior?.waiting ?? [], state: 'retrying' }))
      throw error
    } finally { guard(); await this.d.onChange(owner) }
  }
}
