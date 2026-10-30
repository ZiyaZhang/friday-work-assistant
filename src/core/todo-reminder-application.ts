import type { DatabaseSync } from 'node:sqlite'
import type { FeishuClient } from '../feishu/client.js'
import { sendFeishuPayload } from '../feishu/delivery-transport.js'
import { DeliveryError, DeliveryService, deliveryAudienceKey, type DeliveryAudience, type DeliveryContext, type DeliveryRecord } from './delivery.js'
import type { PolicyService } from './policy.js'
import type { Registry } from './registry.js'
import { dmSpaceId, type Spaces } from './space.js'
import { ACTIVE_STATUSES, KIND_LABEL, reminderFor, stagesFor, type DueReminder, type ReminderStage, type Todo, type Todos } from './todos.js'
import type { ReportedRefs } from './reported-refs.js'
import { presentTodoOrigin } from './todo-origin-presentation.js'
import { linkedGithubTitle } from './github-links.js'

const STAGES: ReminderStage[] = ['72h', '24h', '2h', '1h', 'overdue']
export function todoReminderKey(id: number, dueMs: number, stage: ReminderStage): string { return `todo-reminder:${id}:${dueMs}:${stage}` }
export interface TodoReminderResult {
  todoId: number
  dueMs: number
  stage: ReminderStage
  deliveryKey: string
  status: 'sent' | 'recovered' | 'unknown' | 'unavailable' | 'stale'
  reason?: string
  marked?: boolean
}
export interface TodoReminderBatch { sent: number; recovered: number; attempted: number; results: TodoReminderResult[] }
interface Route { actor: string; spaceId: string; chatId: string | null; audience: DeliveryAudience }
class ReminderBlocked extends Error {
  constructor(readonly status: 'unknown' | 'unavailable' | 'stale', readonly reason: string) { super(reason) }
}

/** 固定待办意图 → 逐次授权 → 原 Delivery 收据；不把 cron 扫描变成新的执行身份。 */
export class TodoReminderApplication {
  private readonly now: () => number
  private readonly ledger: DeliveryService
  private readonly reported = new Map<string, string>()

  constructor(private readonly deps: {
    db: DatabaseSync
    todos: Todos
    spaces: Spaces
    policy: PolicyService
    registry: Pick<Registry, 'getSession'>
    feishu: Pick<FeishuClient, 'chatMemberOpenIds' | 'sendToChat' | 'sendToUser'>
    now?: () => number
    /** G8：ACK 之后登记「todo:<id> 已单独提醒过」，简报据此标注；不给就不登记。 */
    reportedRefs?: Pick<ReportedRefs, 'record'>
    /** 仅结果状态变化时调用，不重复打印每分钟相同的不可交付原因。 */
    onStateChange?: (result: TodoReminderResult) => void
  }) {
    this.now = deps.now ?? Date.now
    this.ledger = new DeliveryService(deps.db, { spaces: deps.spaces, policy: deps.policy, now: this.now,
      resolveContext: async () => undefined, send: async () => { throw new Error('read-only reminder ledger') } })
  }

  async runDue(maxNewDeliveries = 50): Promise<TodoReminderBatch> {
    if (!Number.isSafeInteger(maxNewDeliveries) || maxNewDeliveries < 0) throw new Error('提醒数量必须是非负整数')
    const batch: TodoReminderBatch = { sent: 0, recovered: 0, attempted: 0, results: [] }
    for (const candidate of this.deps.todos.reminderCandidates(this.now())) {
      if (batch.attempted >= maxNewDeliveries) break
      const { todo, stage } = candidate, dueMs = todo.dueMs!
      const base = { todoId: todo.id, dueMs, stage, deliveryKey: todoReminderKey(todo.id, dueMs, stage) }
      let result: TodoReminderResult
      try {
        // 先处理同一日期所有旧收据，不能在时间跨级后绕过上一阶段的 unknown。
        this.assertNoUnsettled(todo)
        const route = this.route(todo)
        const acknowledged = this.acknowledged(todo)
        if (acknowledged.length) {
          for (const { record, stage: priorStage } of acknowledged) {
            this.assertReceiptRoute(record, route)
            this.deps.todos.acknowledgeReminder(todo.id, { scope: todo.scope, dueMs, stages: throughStage(todo, priorStage) }, this.now())
            // 补账的是一次真实 ACK：按那次回执的时间登记，不当成新的提醒。
            this.deps.reportedRefs?.record({ ownerOpenId: route.actor, refs: [`todo:${todo.id}`], outputKey: record.key, deliveredAt: record.updatedAt })
          }
          const current = this.deps.todos.get(todo.id)
          // 原 ACK 对应阶段已落库。较晚阶段下一次扫描再发，避免同一轮补账又立刻催一次。
          const restored = current?.scope === todo.scope && current.dueMs === dueMs && ACTIVE_STATUSES.includes(current.status)
          result = { ...base, status: restored ? 'recovered' : 'stale', marked: restored }
          batch.recovered += restored ? 1 : 0
        } else {
          const members = route.audience.kind === 'group'
            ? await this.deps.feishu.chatMemberOpenIds(route.audience.chatId, { fresh: true }).catch(() => { throw new ReminderBlocked('unavailable', 'membership_lookup_failed') })
            : new Set([route.actor])
          if (!members.has(route.actor)) throw new ReminderBlocked('unavailable', 'creator_not_current_member')
          const mentions = todo.ownerOpenId && route.audience.kind === 'group' && members.has(todo.ownerOpenId) ? [todo.ownerOpenId] : []
          const context: DeliveryContext = { actorOpenId: route.actor, audience: route.audience,
            sources: [{ ref: `todo:${todo.id}`, spaceId: route.spaceId, chatId: route.chatId }],
            provenanceComplete: true, expiresAt: this.now() + 60_000, mentionOpenIds: mentions }
          const delivery = new DeliveryService(this.deps.db, { spaces: this.deps.spaces, policy: this.deps.policy, now: this.now,
            resolveContext: async () => context,
            admit: () => {
              this.assertCurrent(candidate, route)
              this.assertNoUnsettled(todo)
              if (batch.attempted >= maxNewDeliveries) throw new ReminderBlocked('stale', 'batch_limit')
            },
            send: async ({ audience, payload, mentionOpenIds }) => {
              batch.attempted++
              return sendFeishuPayload(this.deps.feishu, audience.kind === 'group'
                ? { kind: 'chat', id: audience.chatId } : { kind: 'user', id: audience.openId }, payload, { mentionOpenIds })
            },
          })
          const receipt = await delivery.deliver({ key: base.deliveryKey, contextRef: base.deliveryKey,
            payload: { markdown: renderReminder(todo, stage, mentions, this.deps.todos.getProvenance(todo.id)?.collection?.quote) } })
          // G8：只在拿到 ACK 之后登记；deliver 抛错（结果未知、被拒）不会走到这里。重放的回执按原 ACK 时间登记。
          this.deps.reportedRefs?.record({ ownerOpenId: route.actor, refs: [`todo:${todo.id}`], outputKey: base.deliveryKey, deliveredAt: receipt.updatedAt })
          let marked = false, markerFailed = false
          try { marked = this.deps.todos.acknowledgeReminder(todo.id, { scope: todo.scope, dueMs, stages: throughStage(todo, stage) }, this.now()) }
          catch { markerFailed = true }
          result = { ...base, status: receipt.replayed ? 'recovered' : 'sent', marked, ...(markerFailed ? { reason: 'marker_update_failed' } : {}) }
          if (receipt.replayed) batch.recovered++
          else batch.sent++
        }
      } catch (error) {
        result = { ...base, status: error instanceof ReminderBlocked ? error.status : error instanceof DeliveryError && error.code === 'unknown' ? 'unknown' : 'unavailable',
          reason: error instanceof ReminderBlocked ? error.reason : error instanceof DeliveryError ? `delivery_${error.code}` : 'reminder_failed' }
      }
      batch.results.push(result)
      const state = `${result.status}:${result.reason ?? ''}:${result.marked ?? ''}`
      if (this.reported.get(result.deliveryKey) !== state) {
        this.reported.set(result.deliveryKey, state)
        this.deps.onStateChange?.(result)
      }
    }
    return batch
  }

  private assertNoUnsettled(todo: Todo): void {
    for (const stage of STAGES) {
      const record = this.ledger.get(todoReminderKey(todo.id, todo.dueMs!, stage))
      if (record && (record.status === 'planned' || record.status === 'unknown' || !record.remoteId)) throw new ReminderBlocked('unknown', 'prior_delivery_unsettled')
    }
  }

  private acknowledged(todo: Todo): { record: DeliveryRecord; stage: ReminderStage }[] {
    return STAGES.filter((stage) => !todo.remindedStages.includes(stage)).flatMap((stage) => {
      const record = this.ledger.get(todoReminderKey(todo.id, todo.dueMs!, stage))
      return record && (record.status === 'sent' || record.status === 'confirmed') && record.remoteId ? [{ record, stage }] : []
    })
  }

  private route(todo: Todo): Route {
    const { spaces, registry, policy } = this.deps
    const actor = todo.createdBy
    if (!actor?.trim()) throw new ReminderBlocked('unavailable', 'missing_creator')
    const space = todo.scope.startsWith('space:') ? spaces.get(todo.scope.slice(6))
      : todo.scope.startsWith('user:') ? spaces.get(dmSpaceId(todo.scope.slice(5)))
        : todo.scope.startsWith('chat:') ? spaces.byChat(todo.scope.slice(5), true) : undefined
    if (!space || space.status !== 'active') throw new ReminderBlocked('unavailable', 'space_unavailable')
    if (!spaces.roleOf(space.id, actor) || policy.decide({ spaceId: space.id, openId: actor, action: 'read' }).decision !== 'allow'
      || policy.decide({ spaceId: space.id, openId: actor, action: 'publish', target: 'here' }).decision !== 'allow') throw new ReminderBlocked('unavailable', 'creator_not_authorized')
    if (space.kind === 'p2p') {
      if (space.id !== dmSpaceId(actor)) throw new ReminderBlocked('unavailable', 'not_creator_dm')
      return { actor, spaceId: space.id, chatId: space.chatId, audience: { kind: 'dm', spaceId: space.id, openId: actor } }
    }
    // 催某个人做事 → **私聊他本人**，不在群里 @ 他（2026-09-21 定）。
    // 群里 @ 别人催活是很强的社交动作，机器人替人做容易出事。
    // 但"9/25 封版""明天上线""会议"是全群共同的时间点，不是催谁，仍然发在群里。
    const nudgesOnePerson = (todo.kind === 'todo' || todo.kind === 'deadline') && Boolean(todo.ownerOpenId)
    if (nudgesOnePerson) {
      const owner = todo.ownerOpenId!
      if (!spaces.roleOf(space.id, owner)) throw new ReminderBlocked('unavailable', 'owner_not_in_space')
      const dm = spaces.get(dmSpaceId(owner))
      if (!dm || dm.status !== 'active' || !dm.chatId) throw new ReminderBlocked('unavailable', 'owner_dm_unavailable')
      if (policy.decide({ spaceId: dm.id, openId: owner, action: 'publish', target: 'here' }).decision !== 'allow') {
        throw new ReminderBlocked('unavailable', 'owner_dm_not_authorized')
      }
      return { actor: owner, spaceId: dm.id, chatId: dm.chatId, audience: { kind: 'dm', spaceId: dm.id, openId: owner } }
    }
    const session = todo.sessionKey ? registry.getSession(todo.sessionKey) : undefined
    const originChat = session?.chatType === 'group' ? session.chatId : todo.scope.startsWith('chat:') ? todo.scope.slice(5) : undefined
    if (!originChat || space.chatId !== originChat) throw new ReminderBlocked('unavailable', 'original_chat_unverified')
    return { actor, spaceId: space.id, chatId: originChat, audience: { kind: 'group', spaceId: space.id, chatId: originChat } }
  }

  private assertCurrent(candidate: DueReminder, route: Route): void {
    const current = this.deps.todos.get(candidate.todo.id)
    if (!current || JSON.stringify(current) !== JSON.stringify(candidate.todo)) throw new ReminderBlocked('stale', 'todo_changed')
    if (reminderFor(current, this.now())?.stage !== candidate.stage) throw new ReminderBlocked('stale', 'stage_changed')
    if (JSON.stringify(this.route(current)) !== JSON.stringify(route)) throw new ReminderBlocked('stale', 'audience_changed')
  }

  private assertReceiptRoute(record: DeliveryRecord, route: Route): void {
    if (record.actorOpenId !== route.actor || deliveryAudienceKey(record.audience) !== deliveryAudienceKey(route.audience)) throw new ReminderBlocked('unavailable', 'receipt_audience_changed')
  }
}

function throughStage(todo: Todo, stage: ReminderStage): ReminderStage[] {
  const stages = stagesFor(todo.kind), index = stages.indexOf(stage)
  return index < 0 ? [stage] : stages.slice(0, index + 1)
}
function literal(text: string): string { return text.replace(/<(?=\/?at\b)/gi, '<\u200b') }
function renderReminder(todo: Todo, stage: ReminderStage, mentions: string[], githubEvidence?: string): string {
  const due = new Date(todo.dueMs!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  // Stages are thresholds: a newly created item can enter the 24h stage with
  // only minutes left. Display the real due time, never the threshold as an ETA.
  const lead = `${stage === 'overdue' ? '已过期 · ' : ''}${due} ${todo.kind === 'meeting' ? '开始' : '截止'}（北京时间）`
  const owner = todo.ownerOpenId && mentions.includes(todo.ownerOpenId) ? `<at open_id="${todo.ownerOpenId}">${literal(todo.owner ?? '')}</at>` : todo.owner ? `负责人 ${literal(todo.owner)}` : ''
  const state = todo.status === 'blocked' ? `（阻塞中${todo.statusNote ? `：${literal(todo.statusNote)}` : ''}）` : todo.status === 'review' ? '（待验收）' : ''
  const lines = [`**${linkedGithubTitle(todo.title, githubEvidence)}**${state}`, `${KIND_LABEL[todo.kind]} · ${lead}${owner ? ` · ${owner}` : ''}`]
  if (todo.detail) lines.push(literal(todo.detail.slice(0, 200)))
  if (!todo.confirmed) lines.push('归属待核实。')
  const origin = presentTodoOrigin(todo.origin)?.items.find(item => item.url)
  if (origin?.url) lines.push(`[查看原消息](${origin.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`)
  return lines.join('\n')
}
