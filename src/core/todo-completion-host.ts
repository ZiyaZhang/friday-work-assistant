/**
 * 待办按证据标完成的宿主调用（接口文档 §9）。判断规则全部在 TodoCompletionEvidence 里，这里只接线：
 *
 * - 只在本人自己的交互任务里调用；本人身份和会话由调用方（内部 API）从 cap 取，不来自模型参数。
 * - 取本人名下（规则跟 Todos.listOwnedBy 走）、当前会话能看到的全部未完成待办，一次交给 assess。
 *   同一话题里记下的待办都在同一个会话里，所以按当前会话取全，不会漏掉“同一话题有两条”的歧义。
 * - definite：一个事务里用 TodoApplication 标完成（带读到时的 tag，statusNote 写依据，statusBy 写 friday:evidence），
 *   同时记下用过的证据。写之前再核对一次调用方给的写入条件；不满足，或待办在判断期间被改过，就不写，改成请本人确认。
 * - probable：不写，只列出来请本人确认。
 * - 话题消息只认缓存里有的；本人现在读不到的会话里的话不当证据（私聊只认本人自己的私聊；
 *   群要空间在用、本人没有停读、允许读取，且本人仍在群里）。Friday 自己发的消息不算。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChatReadScope } from './chat-read-scope.js'
import type { MessageCache } from './message-cache.js'
import type { PolicyService } from './policy.js'
import { dmSpaceId, spaceScope, type Spaces } from './space.js'
import { TodoApplicationError, todoTag, type TodoApplication } from './todo-application.js'
import { ensureTodoCompletionEvidenceSchema, githubRefKey, githubRefs, githubStateLabel, readGitHubStates, TodoCompletionEvidence,
  type CompletionAssessment, type CompletionEvidenceItem, type CompletionSubject, type GitHubItemState, type GitHubRef } from './todo-completion-evidence.js'
import type { Todo, TodoAudience, Todos } from './todos.js'
import { messageSourceLink } from '../feishu/message-links.js'

/** statusBy 写这个值：这一条是 Friday 按证据标的完成，不是本人自己打的勾。 */
export const EVIDENCE_COMPLETION_ACTOR = 'friday:evidence'
/** 读取上限、并发和链接写法都在 TodoCompletionEvidence 里（PMO「关联」列也用同一套）。
 * 判断本身逐条等待读取结果，所以宿主先按同一种写法把链接找出来并行预读。 */
export { GITHUB_READ_BUDGET } from './todo-completion-evidence.js'
/** 一次最多判断这么多条未完成待办。 */
const SUBJECT_LIMIT = 1000

export type TodoCompletionLink =
  | { kind: 'github'; ref: string; url: string; state: string }
  | { kind: 'message'; messageId: string; chatId: string; at: number; byOwner: boolean; url?: string }

export interface TodoCompletionNote {
  id: number
  title: string
  /** 给人看的一句依据；标了完成的一定有 */
  receipt?: string
  evidence: TodoCompletionLink[]
  /** 按规则可以直接标完成、但这次没写的原因 */
  notApplied?: string
}

export interface TodoCompletionReview {
  /** 这次已按证据标了完成 */
  applied: TodoCompletionNote[]
  /** 看起来做完了，没有改状态，请本人确认 */
  suggested: TodoCompletionNote[]
}

export interface TodoCompletionHostDeps {
  db: DatabaseSync
  todos: Pick<Todos, 'listOwnedBy' | 'getForAudience' | 'getProvenance'>
  todoApplication: Pick<TodoApplication, 'update'>
  messages: Pick<MessageCache, 'thread' | 'get'>
  spaces: Pick<Spaces, 'byChat'>
  policy: Pick<PolicyService, 'decide'>
  /** 本人的“停读这个会话”；没有接时按默认可读 */
  readScope?: Pick<ChatReadScope, 'isReadable'>
  /** 群的当前成员（应用身份，fresh）；读不到时抛错 */
  members(chatId: string): Promise<ReadonlySet<string>>
  domain?: 'feishu' | 'lark'
  now?(): number
}

export interface TodoCompletionReviewInput {
  owner: string
  /** 当前会话的待办受众（宿主按 cap 构造；openId 必须就是 owner） */
  audience: TodoAudience
  /** 读一个 Issue / PR 的当前状态；调用方没有 GitHub 读取权限时不传 */
  readGitHub?: (ref: GitHubRef) => Promise<GitHubItemState>
  /** 写入前、在同一事务里核对本人当前交互任务仍能写个人状态；抛错就不写 */
  assertWritable(): void
}

export class TodoCompletionHost {
  constructor(private readonly deps: TodoCompletionHostDeps) {
    // 新表在启动时建好（空表），不在第一次查询时才建
    ensureTodoCompletionEvidenceSchema(deps.db)
  }

  async review(input: TodoCompletionReviewInput): Promise<TodoCompletionReview> {
    const { owner, audience } = input
    const out: TodoCompletionReview = { applied: [], suggested: [] }
    if (!owner || audience.openId !== owner) return out
    const { todos } = this.deps
    const owned = todos.listOwnedBy(owner, { status: 'active', dmScope: spaceScope(dmSpaceId(owner)), limit: SUBJECT_LIMIT })
      .filter(todo => todo.scope === audience.scope && todos.getForAudience(todo.id, audience))
    if (!owned.length) return out
    const byId = new Map(owned.map(todo => [todo.id, todo]))
    const subjects: CompletionSubject[] = owned.map(todo => ({ id: todo.id, title: todo.title, detail: todo.detail, ownerOpenId: owner,
      createdAt: todo.createdAt, source: todos.getProvenance(todo.id)?.request ?? null }))
    const prefetched = input.readGitHub ? readGitHubStates(githubRefs(subjects.flatMap(subject => [subject.title, subject.detail ?? ''])), input.readGitHub)
      : new Map<string, Promise<GitHubItemState>>()
    const readable = await this.readableChats(owner, audience, subjects)
    const evidence = new TodoCompletionEvidence(this.deps.db, {
      threadMessages: (anchor, sinceMs) => this.deps.messages.thread(anchor, sinceMs)
        .filter(message => message.senderType !== 'app')
        .map(message => ({ messageId: message.messageId, chatId: message.chatId, senderOpenId: message.senderOpenId,
          createTimeMs: message.createTimeMs, text: message.text, threadId: message.threadId, rootId: message.rootId, parentId: message.parentId })),
      canRead: (chatId, openId) => openId === owner && readable.has(chatId),
      ...(input.readGitHub ? { readGitHub: (ref: GitHubRef) => prefetched.get(githubRefKey(ref))
        ?? Promise.resolve<GitHubItemState>({ status: 'unavailable', reason: '本次读取的链接太多' }) } : {}),
    })
    for (const assessment of await evidence.assess(owner, subjects)) {
      if (assessment.verdict === 'none') continue
      const todo = byId.get(assessment.todoId)
      if (!todo) continue
      const note: TodoCompletionNote = { id: todo.id, title: todo.title, evidence: assessment.evidence.map(item => this.link(item)) }
      if (assessment.verdict === 'probable') { out.suggested.push(note); continue }
      const failure = this.apply(input, evidence, todo, assessment)
      if (failure) out.suggested.push({ ...note, ...(assessment.receipt ? { receipt: assessment.receipt } : {}), notApplied: failure })
      else out.applied.push({ ...note, receipt: assessment.receipt ?? '依据：已有完成证据' })
    }
    return out
  }

  /** 一个事务：标完成、记下用过的证据。写成功返回 undefined，否则返回没写的原因（事务已回滚）。 */
  private apply(input: TodoCompletionReviewInput, evidence: TodoCompletionEvidence, todo: Todo, assessment: CompletionAssessment): string | undefined {
    const { db, todoApplication } = this.deps
    db.exec('SAVEPOINT todo_completion_by_evidence')
    const rollback = () => db.exec('ROLLBACK TO SAVEPOINT todo_completion_by_evidence; RELEASE SAVEPOINT todo_completion_by_evidence')
    try {
      input.assertWritable()
    } catch (error) {
      rollback()
      return `本轮不能写入个人状态（${error instanceof Error ? error.message : String(error)}）`
    }
    try {
      todoApplication.update(todo.id, input.audience, { expectedTag: todoTag(todo),
        patch: { status: 'done', statusNote: (assessment.receipt ?? '').slice(0, 300) || null } }, input.owner, { statusBy: EVIDENCE_COMPLETION_ACTOR })
      evidence.recordApplied(todo.id, assessment.evidence.map(item => item.key), this.deps.now?.() ?? Date.now())
      db.exec('RELEASE SAVEPOINT todo_completion_by_evidence')
      return undefined
    } catch (error) {
      rollback()
      if (error instanceof TodoApplicationError) return error.code === 'todo_changed' ? '这条待办在判断期间被改过' : error.message
      throw error
    }
  }

  /** 本人现在还能读的会话。当前会话就是本人正在说话的地方；别的群要 fresh 成员里有本人。 */
  private async readableChats(owner: string, audience: TodoAudience, subjects: readonly CompletionSubject[]): Promise<Set<string>> {
    const out = new Set<string>()
    const chats = new Set(subjects.flatMap(subject => subject.source ? [subject.source.chatId] : []))
    for (const chatId of chats) {
      const space = this.deps.spaces.byChat(chatId)
      if (!space || space.status !== 'active' || space.chatId !== chatId) continue
      if (space.kind === 'p2p') {
        if (space.id === dmSpaceId(owner)) out.add(chatId)
        continue
      }
      if (this.deps.readScope && !this.deps.readScope.isReadable(owner, chatId)) continue
      if (this.deps.policy.decide({ spaceId: space.id, openId: owner, action: 'read' }).decision !== 'allow') continue
      if (chatId === audience.chatId) { out.add(chatId); continue }
      try { if ((await this.deps.members(chatId)).has(owner)) out.add(chatId) } catch { /* 成员读不到：这个群里的话不当证据 */ }
    }
    return out
  }

  private link(item: CompletionEvidenceItem): TodoCompletionLink {
    if (item.kind === 'github') {
      const state = githubStateLabel({ kind: item.itemKind, state: item.state, merged: item.merged, stateReason: item.stateReason })
      return { kind: 'github', ref: item.ref, url: item.url, state }
    }
    const cached = this.deps.messages.get(item.messageId)
    const url = cached ? messageSourceLink(cached, this.deps.domain) : undefined
    return { kind: 'message', messageId: item.messageId, chatId: item.chatId, at: item.at, byOwner: item.byOwner, ...(url ? { url } : {}) }
  }
}
