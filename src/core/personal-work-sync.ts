import { createHash } from 'node:crypto'
import type { Registry } from './registry.js'
import type { Todo, Todos, TodoAudience } from './todos.js'
import type { TodoProvenance, TodoGitHubSource } from './todo-provenance.js'
import { TodoApplication, todoTag } from './todo-application.js'
import type { PersonalGitHubState } from '../github/personal-work.js'

const TTL = 5 * 60_000
const fingerprint = (todo: Todo, source: TodoProvenance) => createHash('sha256').update(JSON.stringify([todoTag(todo), source.collection, source.github])).digest('hex')
interface Receipt { fingerprint: string; at: number; attemptedAt: number; state?: PersonalGitHubState; login?: string; grant?: number }

/** A link is a work identity only when extraction scoped the action to that object. Old review requests
 * can be recognized conservatively; unlinked legacy tasks remain untouched instead of guessing by title. */
export function personalGitHubSource(todo: Todo, source: TodoProvenance): TodoGitHubSource | undefined {
  if (source.github) return source.github
  const evidence = source.collection
  if (!evidence || evidence.relationship === 'uncertain') return
  const links = [...evidence.quote.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[1-9]\d*(?=$|[^A-Za-z0-9_./-])/g)].map(match => match[0])
  if (new Set(links).size !== 1 || /上线|发布|部署|验收|通知|转告|回复|release|deploy|rollout/i.test(todo.title)) return
  const bound = evidence.github
  if (bound && links[0] === bound.url && (bound.completion === 'reviewed' ? /review|评审|审查|检视/i.test(todo.title)
    : bound.completion === 'merged' ? /修复|修改|合并|合入|merge|fix|实现|提交/i.test(todo.title)
    : /解决|修复|实现|处理|fix|implement/i.test(todo.title))) return bound
  if (!bound && links[0]?.includes('/pull/') && /review|评审|审查|检视/i.test(todo.title) && /review|评审|审查|检视/i.test(evidence.quote)) {
    return { url: links[0], completion: 'reviewed' }
  }
}

/** One bounded background reader; ordinary list requests only read its cache. It never writes GitHub. */
export class PersonalWorkSync {
  private busy = false
  private application: TodoApplication
  constructor(private readonly d: { registry: Registry; todos: Todos; now(): number; enabled(): boolean
    audience(owner: string): TodoAudience; readable(owner: string, source: TodoProvenance): boolean; canRead(repo: string, owner?: string): boolean
    identity?(owner: string): { login?: string; grant?: number }
    readSource(owner: string, source: TodoProvenance, guard: () => void): Promise<void>
    read(link: TodoGitHubSource, login: string | undefined, guard: () => void, owner?: string): Promise<PersonalGitHubState>
    onChange?(owner: string): Promise<void>
  }) { this.application = new TodoApplication({ db: d.registry.db, todos: d.todos }) }
  private key(owner: string, id: number) { return `personal-work:${owner}:${id}` }
  private receipt(owner: string, id: number): Receipt | undefined {
    const value = this.d.registry.getKv(this.key(owner, id)); return value ? JSON.parse(value) as Receipt : undefined
  }
  private identity(owner: string) { return this.d.identity?.(owner) ?? { login: this.d.registry.getKv(`github_login:${owner}`) } }
  current(owner: string, todo: Todo): PersonalGitHubState | undefined {
    const source = this.d.todos.getProvenance(todo.id), receipt = this.receipt(owner, todo.id)
    const link = source && personalGitHubSource(todo, source)
    const identity = this.identity(owner)
    if (!source || !this.d.readable(owner, source) || (source.collection?.ownerOpenId ?? source.github?.ownerOpenId) !== owner || !receipt || receipt.login !== identity.login || receipt.grant !== identity.grant ||
      !link || !this.d.canRead(new URL(link.url).pathname.split('/').slice(1, 3).join('/'), owner) || receipt.fingerprint !== fingerprint(todo, source) || this.d.now() - receipt.at >= TTL) return
    return receipt.state
  }
  async tick(): Promise<void> {
    if (this.busy || !this.d.enabled()) return
    this.busy = true
    try {
      const owners = this.d.registry.db.prepare('SELECT open_id FROM personal_collection_profiles WHERE enabled=1 ORDER BY open_id').all().map(row => String(row.open_id))
      if (this.d.identity) for (const row of this.d.registry.db.prepare("SELECT owner FROM github_user_connections WHERE status='connected'").all()) if (!owners.includes(String(row.owner))) owners.push(String(row.owner))
      owners.sort((a, b) => Number(this.d.registry.getKv(`personal-work-last:${a}`) ?? 0) - Number(this.d.registry.getKv(`personal-work-last:${b}`) ?? 0))
      for (const owner of owners.slice(0, 4)) {
        if (!this.d.enabled()) break
        this.d.registry.setKv(`personal-work-last:${owner}`, String(this.d.now()))
        try { await this.refresh(owner) } catch { /* Each owner is independent; no raw provider errors enter logs. */ }
      }
    } finally { this.busy = false }
  }
  private async refresh(owner: string): Promise<void> {
    const audience = this.d.audience(owner), { login, grant } = this.identity(owner)
    const profile = this.d.registry.db.prepare('SELECT revision FROM personal_collection_profiles WHERE open_id=? AND enabled=1').get(owner)
    if (!profile && !this.d.identity) return
    const items = this.d.todos.listForAudience(audience, { status: 'all', limit: 1000 }).items.filter(todo =>
      ['open', 'blocked', 'review'].includes(todo.status) || todo.statusBy === 'personal-github')
      .sort((a, b) => (this.receipt(owner, a.id)?.attemptedAt ?? 0) - (this.receipt(owner, b.id)?.attemptedAt ?? 0))
    let requests = 0, changed = false
    for (const todo of items) {
      const source = this.d.todos.getProvenance(todo.id), link = source && personalGitHubSource(todo, source)
      if (!source || (source.collection?.ownerOpenId ?? source.github?.ownerOpenId) !== owner || !link || !this.d.readable(owner, source)) continue
      const before = fingerprint(todo, source), previous = this.receipt(owner, todo.id)
      if (previous && previous.fingerprint === before && previous.login === login && previous.grant === grant && this.d.now() - previous.attemptedAt < TTL) continue
      if (requests++ >= 3) break
      const guard = () => {
        const current = this.d.todos.getForAudience(todo.id, this.d.audience(owner)), evidence = current && this.d.todos.getProvenance(todo.id)
        if (!this.d.enabled() || !current || !evidence || fingerprint(current, evidence) !== before || !this.d.readable(owner, evidence) ||
          this.d.audience(owner).chatId !== audience.chatId || this.identity(owner).login !== login || this.identity(owner).grant !== grant ||
          this.d.registry.db.prepare('SELECT revision FROM personal_collection_profiles WHERE open_id=? AND enabled=1').get(owner)?.revision !== profile?.revision) throw new Error('个人事项或授权已变化')
      }
      try {
        guard(); await this.d.readSource(owner, source, guard); guard()
        const state = await this.d.read(link, login, guard, owner); guard()
        if (state.url !== link.url) throw new Error('工作对象已变化')
        let final = todo
        const collectedTag = this.d.registry.db.prepare('SELECT last_tag FROM personal_collection_items WHERE todo_id=? AND open_id=?').get(todo.id, owner)?.last_tag
        const manual = this.d.registry.getKv(`personal-work-manual:${owner}:${todo.id}`) === 'true' ||
          Boolean(collectedTag && collectedTag !== todoTag(todo)) && todo.statusBy !== 'personal-github'
        const desired = state.completion ?? (todo.statusBy === 'personal-github' && state.state === 'open' ? 'open' : undefined)
        if (!manual && desired && desired !== todo.status) {
          final = this.application.update(todo.id, audience, { expectedTag: todoTag(todo), patch: { status: desired, statusNote: state.note } }, owner,
            { statusBy: 'personal-github' }).todo
        }
        const receipt: Receipt = { fingerprint: fingerprint(final, source), at: this.d.now(), attemptedAt: this.d.now(), state, ...(login ? { login } : {}), ...(grant === undefined ? {} : { grant }) }
        this.d.registry.setKv(this.key(owner, todo.id), JSON.stringify(receipt))
        changed ||= JSON.stringify(previous?.state) !== JSON.stringify(state) || final.status !== todo.status
      } catch {
        // Retain the last observation, but expire it so a failed read cannot produce a fresh recommendation.
        this.d.registry.setKv(this.key(owner, todo.id), JSON.stringify({ fingerprint: before, at: 0, attemptedAt: this.d.now(), ...(login ? { login } : {}), ...(grant === undefined ? {} : { grant }) }))
        changed ||= Boolean(previous?.state)
      }
    }
    if (changed) await this.d.onChange?.(owner)
  }
}
