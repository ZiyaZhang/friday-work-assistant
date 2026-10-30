/**
 * 结清“等你拍板”的事：聊天、卡片和管理入口都调这一个操作，不各自改 inbox_items。
 *
 * 规则：
 * - 只有这件事的本人能结清；请求所在的会话必须是本人私聊，或这件事原来所在的群（群要仍在用、本人仍在群里）。
 * - 结清针对调用方看到的那一版（version）。同一件事后来又重新等人（同一句问题再问、授权再次到期）是新的一版，旧引用关不掉它。
 * - 同一结论重放返回已有结果；已经以别的结论结清的，返回冲突，不覆盖。
 * - 领域指针以所属领域为准：职责提案“不用了”＝忽略这条提案（同一事务结清指针，只在提案所在的会话里）；“定了”不替人猜接受还是忽略；
 *   授权、技能提议交回各自领域处理（在领域里暂停/删除/重新授权/决定时指针会一起结清）。
 * - 独立的待决断（kind='decision'，包括 Issue 有效性确认后记下的“请决定下一步”）在它自己的记录上结清：
 *   IssueValidityRequests 在记下这条时已经是 confirmed 终态，没有任何状态在等这条指针。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Inbox, PendingItem, PendingKind } from './inbox.js'
import type { ProposalDecisionResult, RoutineApplication } from './routine-application.js'
import type { Routine } from './routines.js'
import { dmSpaceId, type Spaces } from './space.js'

export type DecisionResolution = 'decided' | 'dropped'

/** 请求所在的会话，由宿主按平台消息核实，不来自模型参数。 */
export interface DecisionContext {
  spaceId: string
  chatType: 'p2p' | 'group'
}

export interface ResolveDecisionInput {
  itemId: number
  /** 列表里给出的那一版 */
  expectedVersion: number
  resolution: DecisionResolution
  /** 本人的结论原话，比如“按 P2” */
  note?: string
  /** 平台消息里的真实发送人 */
  operatorOpenId: string
  context: DecisionContext
  /** 宿主事先取得的验证租约（比如刚核过的群成员身份）；在同一事务里、写入之前调用，失效就抛错，什么都不写。 */
  assertCurrent?: () => void
}

export type DecisionDomain =
  | { kind: 'responsibility'; routineId: number; actions: readonly ['accept', 'ignore'] }
  | { kind: 'auth'; routineId: number | null }
  | { kind: 'skill'; proposalId: number | null }
  | { kind: 'unsupported'; pendingKind: PendingKind }

export type DecisionDenial = 'no_operator' | 'not_owner' | 'wrong_space' | 'space_inactive' | 'not_member'

export type ResolveDecisionResult =
  /** paused：这是一对重叠职责的待决定，本人选了暂停其中一条，已在同一事务里暂停（G9）。 */
  | { outcome: 'resolved'; changed: true; item: PendingItem; paused?: Routine; afterCommit?: () => void }
  /** 一对重叠职责的待决定，但结论看不出选了哪一项：保留两条 / 暂停 A / 暂停 B。什么都没写。 */
  | { outcome: 'needs_choice'; changed: false; item: PendingItem; options: { keep: string; pause: { id: number; name: string }[] } }
  /** 所属领域早已不在等（提案已处理 / 已删除，关注已恢复 / 已暂停），指针按领域结清 */
  | { outcome: 'settled_by_domain'; changed: boolean; item: PendingItem }
  | { outcome: 'already_resolved'; changed: false; item: PendingItem }
  | { outcome: 'conflict'; changed: false; item: PendingItem }
  | { outcome: 'stale'; changed: false; item: PendingItem }
  | { outcome: 'use_domain'; changed: false; item: PendingItem; domain: DecisionDomain }
  | { outcome: 'proposal'; changed: boolean; item: PendingItem; proposal: ProposalDecisionResult }
  | { outcome: 'denied'; changed: false; code: DecisionDenial; reason: string }
  | { outcome: 'not_found'; changed: false }

export class DecisionApplication {
  constructor(private readonly deps: {
    db: DatabaseSync
    inbox: Inbox
    spaces: Spaces
    /** 职责提案指针要走职责自己的决定操作 */
    routines?: RoutineApplication
    now(): number
  }) {}

  /** 这个会话里能看到、能结清的待拍板事项（带 id 和 version）。私聊看本人全部；群里只看本群的。 */
  pendingFor(ownerOpenId: string, context: DecisionContext): PendingItem[] {
    if (context.chatType === 'p2p') return context.spaceId === dmSpaceId(ownerOpenId) ? this.deps.inbox.pending(ownerOpenId) : []
    return this.deps.inbox.pending(ownerOpenId).filter(item => item.spaceId === context.spaceId)
  }

  resolve(input: ResolveDecisionInput): ResolveDecisionResult {
    const { db } = this.deps
    db.exec('SAVEPOINT resolve_pending_decision')
    try {
      const result = this.resolveNow(input)
      db.exec('RELEASE SAVEPOINT resolve_pending_decision')
      // 暂停一条职责要在提交之后才中止它正在跑的 Run；调用方没有外层事务（内部 API 直接调用）。
      if (result.outcome === 'resolved' && result.afterCommit) {
        const { afterCommit, ...rest } = result
        afterCommit()
        return rest
      }
      return result
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT resolve_pending_decision; RELEASE SAVEPOINT resolve_pending_decision')
      throw error
    }
  }

  private resolveNow(input: ResolveDecisionInput): ResolveDecisionResult {
    const { inbox, spaces } = this.deps
    const denied = (code: DecisionDenial, reason: string): ResolveDecisionResult => ({ outcome: 'denied', changed: false, code, reason })
    const operator = input.operatorOpenId?.trim()
    if (!operator) return denied('no_operator', '认不出是谁在说，不能结清待拍板的事')
    const item = inbox.get(input.itemId)
    if (!item) return { outcome: 'not_found', changed: false }
    // 不说是谁的：别人猜一个编号，只能得到“不归你”
    if (item.ownerOpenId !== operator) return denied('not_owner', '没有这件待拍板的事，或它不归你')
    if (input.context.chatType === 'p2p') {
      if (input.context.spaceId !== dmSpaceId(operator)) return denied('wrong_space', '只能在你自己的私聊里处理')
    } else {
      if (item.spaceId !== input.context.spaceId) return denied('wrong_space', '这件事不是在这个群里提的，请在私聊或原来的群里处理')
      const space = spaces.get(input.context.spaceId)
      if (!space || space.status !== 'active' || space.kind !== 'group') return denied('space_inactive', '这个群的空间已停用')
      if (!spaces.roleOf(space.id, operator)) return denied('not_member', '你已不在这个群里，请在私聊里处理')
    }
    if (item.version !== input.expectedVersion) return { outcome: 'stale', changed: false, item }
    if (item.resolvedAt !== null) {
      // 由所属领域结清的（提案已忽略、授权已恢复……）：重放同一句话不是冲突，如实说已由领域处理。
      // 结论为空的是改造前结清的行：那时只有领域会结清（提案、技能、授权），个人待决断没有结清入口。
      if (item.resolution === 'domain' || item.resolution === null) return { outcome: 'settled_by_domain', changed: false, item }
      return item.resolution === input.resolution ? { outcome: 'already_resolved', changed: false, item } : { outcome: 'conflict', changed: false, item }
    }
    if (item.kind === 'decision') {
      // G9：一对重叠职责的问题。结论要能对上三个选项之一；选了暂停就在同一事务里暂停那一条（复用职责的暂停）。
      const overlap = this.deps.routines?.overlapDecision(item.refId)
      let choice: 'keep' | number = 'keep'
      if (overlap && this.deps.routines) {
        const pair = [overlap.a, overlap.b].map(id => this.deps.routines!.routine(id))
        const parsed = overlapChoice(input, overlap, pair)
        if (parsed === undefined) {
          return { outcome: 'needs_choice', changed: false, item,
            options: { keep: '保留两条', pause: pair.flatMap(r => r ? [{ id: r.id, name: r.name }] : []) } }
        }
        choice = parsed
      }
      input.assertCurrent?.()
      if (!inbox.settle({ id: item.id, version: item.version, resolution: input.resolution, by: operator, note: input.note, now: this.deps.now() })) {
        throw new Error('待拍板事项在结清时已变化')
      }
      if (choice === 'keep' || !this.deps.routines) return { outcome: 'resolved', changed: true, item: inbox.get(item.id)! }
      // 先按本人的结论结清，再暂停：暂停会把这对职责的指针按领域结清，已结清的行不再动。
      const control = this.deps.routines.persistControl(choice, 'pause')
      return { outcome: 'resolved', changed: true, item: inbox.get(item.id)!, paused: control.routine, afterCommit: control.afterCommit }
    }
    const routines = this.deps.routines
    if ((item.kind === 'responsibility' || item.kind === 'auth') && routines && item.refId !== null) {
      // 领域先说话。旧代码接受提案与结清指针分两步写，可能留下领域早已不在等的指针。写入之前先核对租约。
      input.assertCurrent?.()
      routines.settlePointers([item.refId], [item.kind])
      const current = inbox.get(item.id)!
      if (current.resolvedAt !== null) return { outcome: 'settled_by_domain', changed: true, item: current }
    }
    if (item.kind === 'responsibility' && item.refId !== null) {
      // “定了”不替人猜接受还是忽略；提案只在它所在的会话里决定（和点卡同一条规则），私聊里说的交回提案卡
      if (input.resolution === 'decided' || !routines || input.context.spaceId !== item.spaceId) {
        return { outcome: 'use_domain', changed: false, item, domain: { kind: 'responsibility', routineId: item.refId, actions: ['accept', 'ignore'] } }
      }
      const status = routines.proposalStatus(item.refId, undefined)
      const version = 'currentConfigVersion' in status ? status.currentConfigVersion : undefined
      // “不用了”是对这条提案当前的样子说的；忽略不会启用任何东西。决定权仍按提案规则核对（空间负责人）。
      const proposal = routines.decideProposal({ routineId: item.refId, expectedConfigVersion: version, decision: 'ignore',
        operatorOpenId: operator, spaceId: item.spaceId ?? '', assertCurrent: input.assertCurrent })
      return { outcome: 'proposal', changed: proposal.changed, item: inbox.get(item.id)!, proposal }
    }
    if (item.kind === 'auth') return { outcome: 'use_domain', changed: false, item, domain: { kind: 'auth', routineId: item.refId } }
    if (item.kind === 'skill') return { outcome: 'use_domain', changed: false, item, domain: { kind: 'skill', proposalId: item.refId } }
    return { outcome: 'use_domain', changed: false, item, domain: { kind: 'unsupported', pendingKind: item.kind } }
  }
}

/**
 * 重叠职责的结论对上哪一项：“不用了”= 保留两条；“暂停 #12”/“暂停「日报」”= 暂停那一条；“保留两条”= 保留。
 * 只按编号或职责名认，认不出（没写、两条都点到、只写编号没说暂停）返回 undefined，让模型再问一次；不猜。
 */
export function overlapChoice(input: Pick<ResolveDecisionInput, 'resolution' | 'note'>, overlap: { a: number; b: number },
  pair: readonly (Routine | undefined)[]): 'keep' | number | undefined {
  if (input.resolution === 'dropped') return 'keep'
  const note = (input.note ?? '').replace(/\s+/g, '').replace(/＃/g, '#')
  if (!note) return undefined
  const ids = [overlap.a, overlap.b]
  const nameOf = (id: number): string => pair.find(r => r?.id === id)?.name.replace(/\s+/g, '') ?? ''
  const named = (id: number): boolean => new RegExp(`#${id}(?!\\d)`).test(note) || (nameOf(id).length > 0 && note.includes(nameOf(id)))
  // “暂停 #2”“先停「晚报」”：动词紧挨着编号或名字的，才算点名要停 / 要留的那一条。
  const adjacent = (verbs: readonly string[], id: number): boolean => verbs.some(verb =>
    new RegExp(`${verb}#${id}(?!\\d)`).test(note) || (nameOf(id).length > 0 && (note.includes(`${verb}「${nameOf(id)}」`) || note.includes(`${verb}${nameOf(id)}`))))
  const paused = ids.filter(id => adjacent(['暂停', '停掉', '停用', '关掉', '先停'], id))
  const kept = ids.filter(id => adjacent(['保留', '留下', '留着', '保住'], id))
  const mentioned = ids.filter(named)
  const wantsPause = /暂停|停掉|停用|关掉|先停/.test(note)
  const wantsKeep = /保留|都留|两条都|都要|不动|留着/.test(note)
  if (paused.length === 1 && mentioned.every(id => paused.includes(id) || kept.includes(id))) return paused[0]
  if (wantsPause && mentioned.length === 1 && !kept.includes(mentioned[0]!)) return mentioned[0]
  if (wantsKeep && !wantsPause) return 'keep'
  return undefined
}
