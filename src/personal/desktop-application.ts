import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PersonalApplication } from '../core/personal-application.js'
import type { PersonalAssistance } from '../core/personal-assistance.js'
import type { PersonalCollectionStore } from '../core/personal-collection.js'
import type { PersonalWorkSync } from '../core/personal-work-sync.js'
import type { GitHubPersonalDiscovery } from '../core/github-personal-discovery.js'
import type { Registry } from '../core/registry.js'
import type { Todos } from '../core/todos.js'
import type { FeishuTaskSync } from '../core/feishu-task-sync.js'
import { todoOrigin } from '../core/todo-provenance.js'
import { presentTodoOrigin } from '../core/todo-origin-presentation.js'
import type { GmailMailbox } from '../gmail/mailbox.js'
import type { GitHubUserConnections } from '../github/user-connection.js'
import { DeviceError, type DeviceActor } from './devices.js'
import type { PersonalResults } from './results.js'
import { parseRunResult, type RunAttempt } from '../core/run-attempts.js'
import { projectWorkProgress, type WorkProgressInput } from '../core/work-progress.js'
import type { PersonalConversation } from './conversation.js'
import { dmThreadKey } from '../feishu/mention.js'
import { DesktopAccounts } from './desktop-accounts.js'
import type { GmailConnections } from '../gmail/connection.js'
import { DesktopMcp } from './desktop-mcp.js'
import type { PersonalMcpConnections } from './mcp-connections.js'
import { DesktopEmail } from './desktop-email.js'
import type { EmailDrafts } from '../gmail/drafts.js'
import { DesktopLocalWork } from './desktop-local.js'
import type { PersonalLocalWork } from './local-work.js'

const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('disconnect') }).strict(),
  z.object({ operation: z.literal('works') }).strict(),
  z.object({ operation: z.literal('conversation'), includeResults: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal('message'), text: z.string().trim().min(1).max(12_000), taskId: z.number().int().positive().optional() }).strict(),
  z.object({ operation: z.literal('result'), taskId: z.number().int().positive(), offset: z.number().int().min(0).max(200_000).default(0),
    conversationId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  z.object({ operation: z.literal('work'), taskId: z.number().int().positive(), revision: z.number().int().positive(), action: z.enum(['stop', 'cancel', 'resume']) }).strict(),
  z.object({ operation: z.literal('list'), view: z.enum(['active', 'later', 'closed']).default('active'), page: z.number().int().min(0).max(100).default(0) }).strict(),
  z.object({ operation: z.literal('item'), id: z.number().int().positive(), version: z.string().min(1).max(80), action: z.enum(['hour', 'tomorrow', 'done', 'ignore', 'undo']) }).strict(),
  z.object({ operation: z.literal('offer'), id: z.uuid(), version: z.string().min(1).max(80), decision: z.enum(['start', 'dismiss']) }).strict(),
])
export class PersonalDesktopApplication {
  private dispatch = new Set<number>()
  private refresh = new Set<string>()
  private effects: (() => void)[] = []
  private email?: DesktopEmail
  private local?: DesktopLocalWork
  private mcp?: DesktopMcp
  private accounts: DesktopAccounts
  constructor(private readonly d: { application: PersonalApplication; registry: Registry; todos: Todos; collection: PersonalCollectionStore;
    taskSync?: FeishuTaskSync;
    assistance: PersonalAssistance; github?: GitHubUserConnections; discovery?: GitHubPersonalDiscovery; work?: PersonalWorkSync; mailbox?: GmailMailbox;
    results?: PersonalResults; conversation?: PersonalConversation; emailDrafts?: EmailDrafts;
    runtimePhase?(taskId: number): WorkProgressInput['runtimePhase'];
    personalMcp?: PersonalMcpConnections; gmail?: GmailConnections; localWork?: PersonalLocalWork; localChanged?(owner: string, id: string): void;
    emailChanged?(owner: string, id: string): Promise<void>; background?(work: () => Promise<void>): void;
    control?(owner: string, taskId: number, revision: number, action: 'stop' | 'cancel' | 'resume'): () => void;
    dispatch(taskId: number): void; changed(owner: string): void; now(): number }) {
    if (d.emailDrafts && d.background && d.emailChanged) this.email = new DesktopEmail({ drafts: d.emailDrafts,
      defer: effect => this.effects.push(effect), background: d.background, changed: d.emailChanged })
    this.accounts = new DesktopAccounts(d)
    if (d.personalMcp) this.mcp = new DesktopMcp(d.personalMcp)
    if (d.localWork) this.local = new DesktopLocalWork({ work: d.localWork,
      changed: (owner, id) => this.effects.push(() => d.localChanged?.(owner, id)) })
  }
  async prepare(owner: string, raw: unknown, guard: () => void) {
    if (raw && typeof raw === 'object' && String((raw as { operation?: unknown }).operation).startsWith('account-')) {
      const current = () => { guard(); this.d.application.audience(owner) }; current()
      return this.accounts.prepare(owner, raw, current)
    }
    if (raw && typeof raw === 'object' && String((raw as { operation?: unknown }).operation).startsWith('mcp-')) {
      const current = () => { guard(); this.d.application.audience(owner) }; current()
      if (!this.mcp) throw new DeviceError('denied', 'MCP 连接尚未启用。')
      return this.mcp.prepare(owner, raw, current)
    }
    if (raw && typeof raw === 'object' && String((raw as { operation?: unknown }).operation).startsWith('local-')) {
      const current = () => { guard(); this.d.application.audience(owner) }; current()
      if (!this.local) throw new DeviceError('denied', '本机执行尚未启用。')
      return this.local.prepare(owner, raw, current)
    }
    if (raw && typeof raw === 'object' && String((raw as { operation?: unknown }).operation).startsWith('email-')) {
      const current = () => { guard(); this.d.application.audience(owner) }
      current()
      if (!this.email) throw new DeviceError('denied', '邮件入口尚未启用。')
      return this.email.prepare(owner, raw, current)
    }
    const parsed = command.safeParse(raw)
    if (!parsed.success) return
    if (parsed.data.operation === 'conversation') {
      const { session, current, conversationId } = this.conversation(owner, guard)
      const includeResults = parsed.data.includeResults
      const latest = () => session ? this.works(owner, true, session.sessionKey, 21).items : []
      current()
      const readers = new Map(await Promise.all((includeResults ? latest().slice(0, 20).filter(item => item.resultAvailable) : []).map(async item => {
        try { return [item.id, await this.d.results?.read(owner, item.id, current)] as const }
        catch { current(); return [item.id, undefined] as const }
      })))
      current()
      return () => {
        current()
        // Work can finish and new inputs can arrive during source revalidation.
        // Refresh their state without disclosing any newly completed body before its own check.
        const rows = latest(), items = rows.slice(0, 20).reverse().map(item => {
          const answer = readers.get(item.id)?.()
          return { ...item, body: answer?.body.slice(0, 8_000), truncated: Boolean(answer && answer.body.length > 8_000),
            answerAt: answer?.createdAt ?? item.answerAt, unavailable: item.resultAvailable && readers.has(item.id) && !answer,
            resultPending: item.resultAvailable && !readers.has(item.id) }
        })
        const snapshot = { items, hasMore: rows.length > 20, updatedAt: this.d.now(), conversationId, resultsValidated: includeResults }
        // The device envelope is capped at 600 KB after base64 encoding. Keep
        // complete requests, shortening oldest answer previews before dropping old turns.
        const size = () => Buffer.byteLength(JSON.stringify(snapshot))
        for (const item of items) {
          if (size() <= 430_000) break
          if (item.body && item.body.length > 500) { item.body = item.body.slice(0, 500); item.truncated = true }
        }
        while (items.length > 1 && size() > 430_000) { items.shift(); snapshot.hasMore = true }
        return snapshot
      }
    }
    if (parsed.data.operation !== 'result') return
    if (!this.d.results) throw new DeviceError('denied', '结果入口尚未启用。')
    const taskId = parsed.data.taskId, expectedConversation = parsed.data.conversationId
    const selected = expectedConversation ? this.conversation(owner, guard) : undefined
    const current = () => {
      guard(); this.d.application.audience(owner)
      if (selected) {
        selected.current()
        if (selected.conversationId !== expectedConversation || !selected.session ||
          this.d.registry.getTask(taskId)?.sessionKey !== selected.session.sessionKey)
          throw new DeviceError('conflict', '对话已变化，请刷新后继续。')
      }
    }
    const read = await this.d.results.read(owner, taskId, current)
    const offset = parsed.data.offset
    return () => {
      const value = read(), end = Math.min(value.body.length, offset + 64_000)
      return { taskId: value.taskId, body: value.body.slice(offset, end), answerAt: value.createdAt, resultVersion: value.version,
        ...(end < value.body.length ? { nextOffset: end } : {}) }
    }
  }
  execute(actor: DeviceActor, raw: unknown, requestId: string): unknown {
    actor.assertCurrent(); this.d.application.audience(actor.owner)
    const parsed = command.safeParse(raw)
    if (!parsed.success) throw new DeviceError('invalid', '不支持的 Friday 操作。')
    const input = parsed.data, owner = actor.owner
    if (input.operation === 'disconnect') { actor.disconnect(); return { disconnected: true } }
    if (input.operation === 'result' || input.operation === 'conversation') throw new DeviceError('denied', '请重新核对结果来源。')
    if (input.operation === 'works') return this.works(owner)
    if (input.operation === 'message') {
      if (!this.d.conversation) throw new DeviceError('denied', '对话入口尚未启用。')
      const taskId = this.d.conversation.accept(actor, requestId, input.text, input.taskId)
      this.dispatch.add(taskId); return { taskId }
    }
    if (input.operation === 'work') {
      const task = this.works(owner).items.find(item => item.id === input.taskId)
      if (!task || !this.d.control) throw new DeviceError('denied', '当前账号不能操作这项工作。')
      this.effects.push(this.d.control(owner, input.taskId, input.revision, input.action))
      this.refresh.add(owner); return { ok: true }
    }
    if (input.operation === 'item') {
      this.assertGithubItem(owner, input.id)
      this.d.application.updateItem(owner, { id: input.id, version: input.version, operation: input.action })
      this.refresh.add(owner)
      return { ok: true }
    }
    if (input.operation === 'offer') {
      const task = this.d.assistance.decide({ actorId: owner, requestId, source: { surface: 'desktop', reference: `${actor.deviceId}:${requestId}` }, ...input })
      if (task) this.dispatch.add(task.id)
      this.refresh.add(owner)
      return { ok: true, taskId: task?.id ?? null }
    }
    const result = this.d.application.query(owner, input.view)
    const visible = result.items.filter(todo => { try { this.assertGithubItem(owner, todo.id); return true } catch { return false } })
    const page = Math.min(input.page, Math.max(0, Math.ceil(visible.length / 20) - 1))
    const items = visible.slice(page * 20, (page + 1) * 20).map(todo => {
      const source = this.d.todos.getProvenance(todo.id), message = source?.collection?.message
      const preparation = input.view === 'active' ? this.d.assistance.suggest(owner, [todo], { general: true }) : undefined
      return { id: todo.id, title: todo.title, version: this.d.application.itemVersion(owner, todo), status: todo.status, dueMs: todo.dueMs,
        kind: source?.collection?.kind ?? 'todo', context: source?.collection?.quote ?? null,
        place: message?.chatName ?? null, person: message?.senderName ?? null, at: message?.createTimeMs ?? source?.github?.updatedAt ?? null,
        origin: presentTodoOrigin(todoOrigin(source)), githubUrl: source?.github?.url ?? source?.collection?.github?.url ?? null,
        progress: this.d.work?.current(owner, todo)?.note ?? todo.statusNote ?? null,
        native: this.d.taskSync?.view(todo) ?? null, preparation: preparation ? this.presentOffer(preparation) : null }
    })
    const offer = input.view === 'active' ? this.d.assistance.suggest(owner, visible) : undefined
    const suggestion = offer ? this.presentOffer(offer) : null
    const mail = this.d.mailbox?.items(owner).map(item => ({ id: item.thread.id, title: item.title, state: item.state, reason: item.reason, quote: item.quote,
      url: item.thread.url, at: item.thread.messages.at(-1)?.at, from: item.thread.messages.at(-1)?.from })) ?? []
    actor.assertCurrent()
    return { items, suggestion, mail, waiting: this.d.discovery?.view(owner)?.waiting ?? [],
      collection: this.d.collection.progress(owner), page, pages: Math.ceil(visible.length / 20), total: visible.length,
      partial: result.total > result.loaded, updatedAt: this.d.now(), nativeSync: this.d.taskSync?.availability(visible) ?? null }
  }
  private presentOffer(offer: NonNullable<ReturnType<PersonalAssistance['suggest']>>) {
    return { id: offer.id, version: offer.version, todoId: offer.todoId, title: offer.title, label: offer.label,
      description: offer.description, prUrl: offer.prUrl, taskId: offer.taskId,
      state: offer.taskId ? this.d.assistance.completed(offer.taskId) ? 'completed' : this.d.registry.getTask(offer.taskId)?.status ?? 'unavailable' : 'available' }
  }
  private works(owner: string, includeRequest = false, sessionKey?: string, limit = 100) {
    const audience = this.d.application.audience(owner), registry = this.d.registry
    const rows = registry.db.prepare(`SELECT t.id FROM tasks t JOIN sessions s ON s.session_key=t.session_key
      WHERE t.requester_open_id=? AND s.requester_open_id=? AND s.chat_id=? AND s.chat_type='p2p'
      AND s.status!='archived' AND (? IS NULL OR t.session_key=?) ORDER BY t.id DESC LIMIT ?`).all(owner, owner, audience.chatId!, sessionKey ?? null, sessionKey ?? null, limit)
    const items = rows.flatMap(row => {
      const task = registry.getTask(Number(row.id))!, reference = registry.taskWork.get(task.id)
      const work = reference && registry.workContexts.view(reference.key)
      const offer = this.d.assistance.forTask(task.id), inbound = registry.dispatches.get(task.id)?.inbound
      // Only user-authored request text is shown in history. Host prompts and
      // retrieved context never become a desktop title.
      const title = offer ? offer.label : inbound?.senderType === 'user' ? inbound.text : 'Friday 的准备工作'
      const run = registry.db.prepare(`SELECT state,stop_reason,result_json FROM run_attempts WHERE task_id=? AND stage='task' ORDER BY started_at DESC,rowid DESC LIMIT 1`).get(task.id)
      const progress = projectWorkProgress({ task, work, runtimePhase: this.d.runtimePhase?.(task.id), run: run ? { state: run.state as RunAttempt['state'], stopReason: run.stop_reason as string | null,
        result: parseRunResult(run.result_json) } : null })
      if (progress.state === 'waiting_user' && progress.nextAction === 'confirm_permission') progress.detail = '请到 Friday 飞书私聊查看具体参数并确认；确认前不会执行。'
      const result = includeRequest ? this.d.results?.metadata(owner, task.id) : undefined
      return [{ id: task.id, title: title.slice(0, 200), ...(includeRequest ? { request: title.slice(0, 12_000), resultVersion: result?.version,
        answerAt: result?.createdAt } : {}), at: task.createdAt,
        origin: inbound?.senderType === 'user' ? inbound.personalDevice ? 'desktop' as const : 'feishu' as const : undefined,
        progress, resultAvailable: includeRequest ? Boolean(result) : this.d.results?.has(owner, task.id) ?? false,
        work: work ? { key: work.workKey, revision: work.revision,
          canContinue: work.lifecycle === 'open' && work.pauseReasons.every(p => p.reason === 'run_stop'),
          canStop: task.status === 'running' && run?.state === 'running',
          canCancel: work.lifecycle === 'open' && ['queued', 'running'].includes(task.status),
          canResume: work.lifecycle === 'open' && work.pending.inputs > 0 && work.pauseReasons.length > 0 && work.pauseReasons.every(p => p.reason === 'run_stop') } : null }]
    })
    return { items, updatedAt: this.d.now() }
  }
  private conversation(owner: string, guard: () => void) {
    guard()
    const chatId = this.d.application.audience(owner).chatId
    const session = this.d.registry.resolveSession([dmThreadKey(owner)])
    const conversationId = createHash('sha256').update(JSON.stringify([owner, chatId, session?.sessionKey ?? null])).digest('hex')
    const current = () => {
      guard()
      const selected = this.d.registry.resolveSession([dmThreadKey(owner)])
      if (this.d.application.audience(owner).chatId !== chatId || selected?.sessionKey !== session?.sessionKey ||
        selected && (selected.requesterOpenId !== owner || selected.chatId !== chatId || selected.chatType !== 'p2p' || selected.status === 'archived'))
        throw new DeviceError('conflict', '对话已变化，请刷新后继续。')
    }
    current()
    return { session, current, conversationId }
  }
  private assertGithubItem(owner: string, id: number) {
    const source = this.d.todos.getProvenance(id)?.github
    if (!source) return
    const connection = this.d.github?.view(owner)
    if (source.ownerOpenId !== owner || connection?.status !== 'connected' || connection.accountId !== source.accountId || connection.revision !== source.revision)
      throw new DeviceError('denied', '事项来源的 GitHub 连接已变化。')
  }
  /** Called only after the device operation's SQLite transaction has committed. */
  afterCommit() {
    const tasks = [...this.dispatch], owners = [...this.refresh], effects = this.effects; this.dispatch.clear(); this.refresh.clear(); this.effects = []
    for (const effect of effects) effect()
    for (const id of tasks) if (this.d.registry.getTask(id)?.status === 'queued') this.d.dispatch(id)
    for (const owner of owners) this.d.changed(owner)
  }
  discardEffects() { this.dispatch.clear(); this.refresh.clear(); this.effects = [] }
}
