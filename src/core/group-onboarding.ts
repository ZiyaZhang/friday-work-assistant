import { createHash } from 'node:crypto'
import type { Registry } from './registry.js'
import type { Spaces, Space } from './space.js'
import type { PolicyService } from './policy.js'
import type { Proactive } from './proactive.js'
import { describeSchedule, type Routine, type RoutineStore, type ScheduleSpec } from './routines.js'
import type { RoutineApplication } from './routine-application.js'
import type { CardAction } from '../feishu/ws.js'

const FEATURES = ['proactive', 'brief', 'todos', 'github', 'polls'] as const
type Feature = typeof FEATURES[number]
const jobs: Partial<Record<Feature, { title: string; description: string; schedule: ScheduleSpec; prompt: string }>> = {
  brief: { title: '每日早报', description: '工作日 09:00（北京时间）· 本群进展、风险和今日重点',
    schedule: { type: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
    prompt: '使用 group-digest 的每日简报格式，读取本群最近 24 小时的讨论及本空间已登记待办，汇总进展、待确认和风险，附真实原消息或事项链接。只读本群和明确获准向本群展示的来源；不读取私人日历或其他群。不新增待办，不发布到别处。没有新增也简短说明已核实的情况。' },
  todos: { title: '待办汇总', description: '工作日 17:30（北京时间）· 已承诺事项、负责人和截止日',
    schedule: { type: 'daily', at: '17:30', days: [1, 2, 3, 4, 5] },
    prompt: '读取本群今天的讨论和本空间已登记待办，汇总明确承诺的事项、已知负责人、截止日与阻塞，附原消息链接。未认领或推测的事项单列为待确认，不替人认领，不新增或修改待办。只汇总本群；没有值得报告的变化只写 NOTHING。' },
  github: { title: 'PR / Issue 跟进', description: '每 30 分钟核对本群已讨论的事项 · 22:00–09:00 静默',
    schedule: { type: 'interval', everyMinutes: 30, quietHours: { start: '22:00', end: '09:00' } },
    prompt: '只检查本群讨论中明确链接的、工具允许读取的 PR 和 Issue。用工具核对状态，只报告本次新出现的合并、检查失败、阻塞或待决变化，附事项和原话题链接。不扫描整个仓库，不自行建 Issue、评论、提交代码或创建 PR。不把已合并说成已部署。没有可核实的新变化只写 NOTHING。' },
}

/** Card clicks are configuration changes, never model prompts. All state survives a restart. */
export class GroupOnboarding {
  constructor(private readonly deps: { registry: Registry; spaces: Spaces; policy: PolicyService; proactive?: Proactive;
    routines?: RoutineStore; controls: RoutineApplication; polls: boolean; kudos: boolean; github: boolean; now: () => number }) {}

  private key(spaceId: string, feature: Feature) { return `group-setup:${spaceId}:${feature}` }
  private routine(spaceId: string, feature: Feature): Routine | undefined {
    const id = Number(this.deps.registry.getKv(this.key(spaceId, feature)))
    const routine = this.deps.routines?.get(id)
    const space = this.deps.spaces.get(spaceId)
    return routine?.spaceId === spaceId && routine.chatId === space?.chatId && routine.chatType === 'group' ? routine : undefined
  }

  isReadOnlyRoutine(routine: Routine): boolean {
    return Boolean(routine.spaceId && FEATURES.some(feature => this.routine(routine.spaceId!, feature)?.id === routine.id))
  }

  bind(messageId: string, space: Space): void {
    this.deps.registry.setKv(`group-setup-card:${messageId}`, JSON.stringify({ spaceId: space.id, chatId: space.chatId }))
  }

  private state(space: Space, feature: Feature) {
    const { proactive, routines, registry } = this.deps
    const routine = this.routine(space.id, feature)
    const checked = feature === 'proactive' ? Boolean(proactive?.get(space.chatId!).enabled)
      : feature === 'polls' ? space.config.polls === 'on' : Boolean(routine?.enabled && routine.status === 'active')
    const unavailable = feature === 'proactive' ? !proactive : feature === 'polls' ? !this.deps.polls : !routines || feature === 'github' && !this.deps.github
    const revision = createHash('sha256').update(JSON.stringify({ checked, unavailable,
      revision: registry.getKv(`${this.key(space.id, feature)}:revision`),
      routine: routine && [routine.id, routines?.configVersion(routine.id), routine.disabledReason],
      config: feature === 'proactive' ? [space.config.proactive, space.config.kudos] : undefined,
    })).digest('hex').slice(0, 20)
    return { checked, revision, unavailable, routine }
  }

  card(spaceId: string): Record<string, unknown> {
    const space = this.deps.spaces.get(spaceId)
    if (!space || space.kind !== 'group' || space.status !== 'active' || !space.chatId) throw new Error('本群空间已停用。')
    const elements: Record<string, unknown>[] = []
    for (const feature of FEATURES) {
      const state = this.state(space, feature)
      const title = feature === 'proactive' ? (this.deps.kudos ? '主动答疑与点赞' : '主动答疑') : feature === 'polls' ? '需求投票' : jobs[feature]!.title
      const description = feature === 'proactive' ? `有人提问、无人接话时协助${this.deps.kudos ? '；给有帮助的消息点赞' : ''}`
        : feature === 'polls' ? '收集明确的需求意见，按需发起投票' : jobs[feature]!.description
      if (state.unavailable) {
        elements.push({ tag: 'markdown', content: `**${title}**\n<font color="grey">当前未接入</font>` })
        continue
      }
      elements.push({ tag: 'checker', name: feature, checked: state.checked, overall_checkable: true,
        text: { tag: 'plain_text', content: title },
        behaviors: [{ type: 'callback', value: { action: 'group_feature', spaceId, feature, revision: state.revision } }] })
      const timing = state.routine && JSON.stringify(state.routine.schedule) !== JSON.stringify(jobs[feature]?.schedule)
        ? `当前安排：${describeSchedule(state.routine.schedule)}（北京时间）` : description
      elements.push({ tag: 'markdown', content: `<font color="grey">${timing}</font>`, text_size: 'notation' })
    }
    elements.push({ tag: 'markdown', content: '<font color="grey">自动保存</font>', text_size: 'notation' })
    return { schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Friday · 本群功能' }, template: 'blue' }, body: { elements } }
  }

  handle(action: CardAction): Record<string, unknown> {
    const { registry, spaces, policy, proactive, routines, controls } = this.deps
    const value = action.value
    let space: Space | undefined
    try {
      if (action.tag !== 'checker' || typeof action.checked !== 'boolean' || !action.operatorOpenId || !action.chatId || !action.messageId ||
        typeof value.spaceId !== 'string' || typeof value.revision !== 'string' || !FEATURES.includes(value.feature as Feature)) throw new Error('没有收到有效的勾选，请重新打开本群设置。')
      const found = spaces.get(value.spaceId)
      const binding = registry.getKv(`group-setup-card:${action.messageId}`)
      if (!found || found.kind !== 'group' || found.status !== 'active' || found.chatId !== action.chatId ||
        binding !== JSON.stringify({ spaceId: found.id, chatId: found.chatId })) throw new Error('这张卡不能用于当前群，请重新打开本群设置。')
      if (!policy.isAdmin(action.operatorOpenId) && spaces.roleOf(found.id, action.operatorOpenId) !== 'owner') throw new Error('只有本群负责人能修改这些设置。')
      space = found
      const feature = value.feature as Feature
      const state = this.state(space, feature)
      if (state.revision !== value.revision && action.checked !== state.checked) throw new Error('设置已被更新，已刷新为当前状态，请重新勾选。')
      if (action.checked === state.checked) return { card: { type: 'raw', data: this.card(space.id) } }
      if (state.unavailable) throw new Error('该功能尚未准备好，设置没有保存。')
      let afterCommit = () => {}
      registry.db.exec('SAVEPOINT group_feature')
      try {
        if (feature === 'proactive') {
          if (action.checked) proactive!.enable(action.chatId, action.operatorOpenId)
          else proactive!.disable(action.chatId)
          spaces.patchConfig(space.id, { proactive: { enabled: action.checked }, kudos: action.checked && this.deps.kudos ? 'on' : 'off' })
        } else if (feature === 'polls') spaces.patchConfig(space.id, { polls: action.checked ? 'on' : 'off' })
        else {
          const current = this.routine(space.id, feature)
          if (current) afterCommit = controls.persistControl(current.id, action.checked ? 'resume' : 'pause', { expectedConfigVersion: routines!.configVersion(current.id) }).afterCommit
          else if (action.checked) {
            const spec = jobs[feature]!
            const routine = routines!.add({ kind: 'schedule', ownerOpenId: action.operatorOpenId, runAs: action.operatorOpenId, spaceId: space.id,
              chatId: action.chatId, chatType: 'group', name: spec.title, prompt: spec.prompt, schedule: spec.schedule, deliverTo: 'chat',
              deliveryPolicy: feature === 'brief' ? 'every_run' : 'when_nonempty', source: 'user', now: this.deps.now() })
            registry.setKv(this.key(space.id, feature), String(routine.id))
          }
        }
        const revisionKey = `${this.key(space.id, feature)}:revision`
        registry.setKv(revisionKey, String(Number(registry.getKv(revisionKey) ?? 0) + 1))
        registry.db.exec('RELEASE group_feature')
      } catch (error) { registry.db.exec('ROLLBACK TO group_feature; RELEASE group_feature'); throw error }
      afterCommit()
      return { card: { type: 'raw', data: this.card(space.id) } }
    } catch (error) {
      return { toast: { type: 'error', content: error instanceof Error ? error.message : '设置未保存，请稍后再试。' },
        ...(space ? { card: { type: 'raw', data: this.card(space.id) } } : {}) }
    }
  }
}
