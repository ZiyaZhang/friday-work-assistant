import { createHash } from 'node:crypto'
import type { Registry } from './registry.js'
import type { Spaces } from './space.js'
import type { PolicyService } from './policy.js'
import type { ChatReadScope } from './chat-read-scope.js'
import { PERSONAL_COLLECTION_SCOPES, type PersonalCollectionStore } from './personal-collection.js'
import { TodoApplication, todoTag } from './todo-application.js'
import type { Todo, TodoAudience, Todos } from './todos.js'
import type { RoutineStore } from './routines.js'
import type { RoutineApplication } from './routine-application.js'

export type PersonalSettings = { revision: number; collection: boolean; brief: boolean; started: boolean;
  awaiting?: { state: string; revision: number; expiresAt: number; url: string } }
export type PersonalListView = 'active' | 'later' | 'closed'
type Settings = PersonalSettings
type Snooze = { until: number; revision: number }
export interface PersonalApplicationDeps {
  registry: Registry; spaces: Spaces; policy: PolicyService; collection: PersonalCollectionStore
  todos: Todos; application: TodoApplication; readScope?: ChatReadScope
  userTokens: {
    get(openId: string): { scope: string } | undefined
    isConnected(openId: string): boolean
    grantId(openId: string): string | null
    begin(openId: string): string
  }
  authorizeUrl(input: { scopes: string[]; state: string }): string
  routines?: RoutineStore; controls: RoutineApplication
  now(): number; assertActive(): void
}
export type PersonalSettingsCommand =
  | { operation: 'select'; revision: number; feature: 'collection' | 'brief'; checked: boolean }
  | { operation: 'start' | 'retry'; revision: number }
  | { operation: 'refresh' }
export type PersonalItemCommand = { id: number; version: string; operation: 'hour' | 'tomorrow' | 'done' | 'ignore' | 'undo' }
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 20)

/** Personal queries and mutations, independent of cards and transport. Callers
 * supply the authenticated owner; audience, source and revision checks live here. */
export class PersonalApplication {
  constructor(private readonly d: PersonalApplicationDeps) {}
  private key(openId: string) { return `personal-setup:${openId}` }
  private read<T>(key: string): T | undefined {
    const value = this.d.registry.getKv(key)
    return value ? JSON.parse(value) as T : undefined
  }
  private write(key: string, value: unknown) { this.d.registry.setKv(key, JSON.stringify(value)) }
  settings(openId: string): Settings {
    return this.read<Settings>(this.key(openId)) ?? { revision: 1, collection: true, brief: Boolean(this.d.routines), started: false }
  }
  audience(openId: string): TodoAudience {
    this.d.assertActive()
    const space = this.d.spaces.get(`sp_dm_${openId}`)
    if (!space || space.kind !== 'p2p' || !space.chatId || space.status !== 'active' || this.d.spaces.roleOf(space.id, openId) !== 'owner' ||
      this.d.policy.decide({ spaceId: space.id, openId, action: 'remember', target: 'here' }).decision !== 'allow') {
      throw new Error('请在你和 Friday 的私聊中重新打开。')
    }
    return { openId, chatId: space.chatId, chatType: 'p2p', scope: `space:${space.id}` }
  }
  private required(settings: Settings): string[] {
    return [...(settings.collection ? PERSONAL_COLLECTION_SCOPES : []), ...(settings.brief ? ['calendar:calendar:readonly'] : [])]
  }
  private missing(openId: string, settings: Settings): string[] {
    const scopes = new Set(this.d.userTokens.get(openId)?.scope.split(/[\s,]+/) ?? [])
    return this.required(settings).filter(scope => !scopes.has(scope))
  }
  ready(openId: string, settings: Settings): boolean {
    return !this.required(settings).length || this.d.userTokens.isConnected(openId) && !this.missing(openId, settings).length
  }
  authorizationPresented(openId: string): boolean {
    const grant = this.d.userTokens.grantId(openId)
    return Boolean(grant && this.d.registry.getKv(`personal-presented-grant:${openId}`) === grant)
  }
  brief(openId: string) {
    const routine = this.d.routines?.get(Number(this.d.registry.getKv(`personal-brief:${openId}`)))
    return routine?.spaceId === `sp_dm_${openId}` && routine.ownerOpenId === openId && routine.runAs === openId && routine.chatType === 'p2p' ? routine : undefined
  }
  isReadOnlyRoutine(id: number): boolean {
    const routine = this.d.routines?.get(id)
    return Boolean(routine?.ownerOpenId && this.brief(routine.ownerOpenId)?.id === id)
  }

  setup(openId: string) {
    const settings = this.settings(openId), available = this.ready(openId, settings)
    if (!available && (!settings.awaiting || settings.awaiting.revision !== settings.revision || settings.awaiting.expiresAt <= this.d.now())) {
      const state = this.d.userTokens.begin(openId)
      const scopes = [...new Set(['offline_access', 'im:chat:readonly', ...this.required(settings),
        ...(this.d.userTokens.get(openId)?.scope.split(/[\s,]+/).filter(Boolean) ?? [])])]
      settings.awaiting = { state, revision: settings.revision, expiresAt: this.d.now() + 10 * 60_000,
        url: this.d.authorizeUrl({ scopes, state }) }
      this.write(this.key(openId), settings)
    }
    return { settings, available, brief: this.brief(openId), hasRoutines: Boolean(this.d.routines) }
  }

  changeSettings(openId: string, command: PersonalSettingsCommand): void {
    this.audience(openId)
    if (!['select', 'start', 'retry', 'refresh'].includes(command.operation)) throw new Error('这个操作已失效，请刷新卡片。')
    const settings = this.settings(openId)
    if (command.operation !== 'refresh' && settings.revision !== command.revision) throw new Error('设置已更新，请按当前选项操作。')
    if (command.operation === 'select') {
      if (!['collection', 'brief'].includes(command.feature) || typeof command.checked !== 'boolean' || command.feature === 'brief' && !this.d.routines) throw new Error('没有收到有效的选项。')
      settings[command.feature] = command.checked
    } else if (command.operation === 'start') {
      if (!this.ready(openId, settings)) throw new Error('请先完成卡片中的连接。')
      settings.started = true
    }
    if (command.operation !== 'refresh') {
      settings.revision++; delete settings.awaiting
      this.saveAndApply(openId, settings, command.operation === 'select' ? command.feature : undefined)
      if (command.operation === 'retry') this.d.collection.retry(openId)
    }
  }

  private saveAndApply(openId: string, settings: Settings, changed?: 'collection' | 'brief'): void {
    const audience = this.audience(openId), callbacks: (() => void)[] = []
    this.d.registry.db.exec('SAVEPOINT personal_setup')
    try {
      this.write(this.key(openId), settings)
      if (settings.started) {
        const canCollect = settings.collection && this.ready(openId, { ...settings, brief: false })
        const profile = this.d.collection.profile(openId)
        if (changed !== 'brief' && canCollect !== Boolean(profile?.enabled)) this.d.collection.configure(openId, canCollect)
        const canBrief = settings.brief && this.ready(openId, { ...settings, collection: false })
        const brief = this.brief(openId)
        if (changed !== 'collection' && brief && canBrief !== Boolean(brief.enabled && brief.status === 'active')) {
          callbacks.push(this.d.controls.persistControl(brief.id, canBrief ? 'resume' : 'pause', {
            expectedConfigVersion: this.d.routines!.configVersion(brief.id) }).afterCommit)
        } else if (changed !== 'collection' && !brief && canBrief && this.d.routines) {
          const routine = this.d.routines.add({ kind: 'schedule', spaceId: `sp_dm_${openId}`, ownerOpenId: openId, runAs: openId,
            chatId: audience.chatId!, chatType: 'p2p', name: '工作日早报', schedule: { type: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
            prompt: '给本人发今天的工作早报。先调用 friday_my_day 读取现有清单和日历；行动在前，日程在后，附原消息或日程链接。区分待回复、对方交办和本人承诺；不要求逐条确认才能记。不重新全量搜索聊天、不新增或修改事项、不替本人回复别人。只发到本人 Friday 私聊。没有明确期限不编造时间；部分来源未读到就注明，不说已经全部看完。',
            deliverTo: 'dm', deliveryPolicy: 'every_run', source: 'user', now: this.d.now() })
          this.d.registry.setKv(`personal-brief:${openId}`, String(routine.id))
        }
      }
      this.d.registry.db.exec('RELEASE personal_setup')
    } catch (error) { this.d.registry.db.exec('ROLLBACK TO personal_setup; RELEASE personal_setup'); throw error }
    for (const callback of callbacks) callback()
  }

  authorizationCompleted(openId: string): boolean {
    const s = this.settings(openId)
    const matching = s.awaiting?.state === this.d.userTokens.grantId(openId) && s.awaiting.revision === s.revision
    // A generic /connect, another card's OAuth or an obsolete selection must not opt a person in.
    if (!matching && !s.started) return false
    if (matching) {
      s.started = true; s.revision++; delete s.awaiting
      this.saveAndApply(openId, s)
    }
    this.d.collection.retry(openId)
    return true
  }

  private snooze(openId: string, id: number): Snooze { return this.read<Snooze>(`personal-snooze:${openId}:${id}`) ?? { until: 0, revision: 0 } }
  snoozedUntil(openId: string, id: number): number { return this.snooze(openId, id).until }
  itemVersion(openId: string, todo: Todo): string { return hash([todoTag(todo), this.snooze(openId, todo.id)]) }
  visible(openId: string, todo: Todo): boolean {
    const provenance = this.d.todos.getProvenance(todo.id)
    return !provenance?.collection || provenance.collection.ownerOpenId === openId && this.d.readScope?.isReadable(openId, provenance.collection.message.chatId) !== false
  }

  query(openId: string, view: PersonalListView) {
    if (!['active', 'later', 'closed'].includes(view)) throw new Error('清单分类无效。')
    const audience = this.audience(openId), now = this.d.now()
    const list = this.d.todos.listForAudience(audience, { status: view === 'closed' ? 'all' : 'active', limit: 1000 })
    const visible = list.items.filter(todo => this.visible(openId, todo))
    const items = visible.filter(todo => view === 'closed' ? ['done', 'cancelled'].includes(todo.status)
      : view === 'later' ? this.snooze(openId, todo.id).until > now : this.snooze(openId, todo.id).until <= now)
    const collection = (todo: Todo) => this.d.todos.getProvenance(todo.id)?.collection
    items.sort((a, b) => Number(collection(a)?.relationship === 'uncertain') - Number(collection(b)?.relationship === 'uncertain') ||
      (a.dueMs ?? Number.MAX_SAFE_INTEGER) - (b.dueMs ?? Number.MAX_SAFE_INTEGER) ||
      Number(collection(b)?.kind === 'reply') - Number(collection(a)?.kind === 'reply') || b.id - a.id)
    return { audience, items, total: list.total, loaded: list.items.length }
  }

  item(openId: string, id: number, version?: string): Todo {
    const todo = this.d.todos.getForAudience(id, this.audience(openId))
    if (!todo || !this.visible(openId, todo)) throw new Error('这条事项当前不可用。')
    if (version !== undefined && this.itemVersion(openId, todo) !== version) throw new Error('事项已更新，请核对当前版本后操作。')
    return todo
  }

  updateItem(openId: string, input: PersonalItemCommand): void {
    if (!['hour', 'tomorrow', 'done', 'ignore', 'undo'].includes(input.operation)) throw new Error('操作无效，请重新打开清单。')
    if (typeof input.version !== 'string' || !input.version) throw new Error('事项已更新，请核对当前版本后操作。')
    const audience = this.audience(openId), todo = this.item(openId, input.id, input.version)
    const key = `personal-snooze:${openId}:${todo.id}`, snooze = this.snooze(openId, todo.id), op = input.operation
    if (op === 'hour' || op === 'tomorrow') {
      if (!['open', 'blocked', 'review'].includes(todo.status)) throw new Error('这条事项已经结束。')
      const now = this.d.now(), tomorrow = Math.floor((now + 8 * 3600_000) / 86_400_000) * 86_400_000 + 86_400_000 + 3600_000
      this.write(key, { until: op === 'hour' ? now + 3600_000 : tomorrow, revision: snooze.revision + 1 })
    } else {
      if (op !== 'undo' || ['done', 'cancelled'].includes(todo.status)) {
        this.d.application.update(todo.id, audience, { expectedTag: todoTag(todo), patch: {
          status: op === 'done' ? 'done' : op === 'ignore' ? 'cancelled' : 'open', statusNote: op === 'ignore' ? '本人忽略' : null } }, openId)
        this.d.registry.setKv(`personal-work-manual:${openId}:${todo.id}`, 'true')
      }
      if (op === 'undo') this.write(key, { until: 0, revision: snooze.revision + 1 })
    }
  }
}
