/**
 * 待办是不是已经做完了：只找证据、给结论，不改待办。标完成走 TodoApplication，和本人打勾同一个操作。
 *
 * 规则（2026-09-23 定）：
 * - definite（可以不问本人直接标完成，并告诉依据、可撤销）：
 *   ① 待办标题或说明里写了链接的 GitHub Issue 关闭为完成、PR 已合并，且写了的链接全部如此；
 *   ② 本人在这条待办原消息的话题里说做完了，且那时这个话题里只有这一条本人的未完成待办。
 *   飞书任务里勾选完成由原生同步负责，这里不重复处理。
 * - probable（只列出来请本人确认）：别人说做完了、同一话题里有多条待办说不清是哪条、多个链接只完成一部分、Issue 关闭但没有说明原因。
 * - 标过完成又被本人改回来的，同一条证据不再用；新的证据照常判断。
 *
 * 话题消息、能否读取、GitHub 状态都由宿主提供：这里不拉消息、不碰令牌，也不复制消息正文。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { TodoMessageMetadata } from './todo-provenance.js'

/** 宿主把 Todo 和它的来源（todos.getProvenance(id).request）映射成这个形状；ownerOpenId 用 responsibleOpenId(todo)。 */
export interface CompletionSubject {
  id: number
  title: string
  detail: string | null
  ownerOpenId: string
  createdAt: number
  /** 创建这条待办的那条消息；没有来源（旧数据、后台创建）时为 null */
  source: TodoMessageMetadata | null
}

/** 缓存里的一条消息（MessageCache 的 CachedMessage 取这几个字段）。 */
export interface ThreadMessage {
  messageId: string
  chatId: string
  senderOpenId?: string
  createTimeMs: number
  text: string
  threadId?: string
  rootId?: string
  parentId?: string
}

/**
 * 话题定位。同一话题以根消息为准：根消息记下待办时还没有 thread_id，话题里后来的消息都带 root_id = 根消息。
 * 取消息时按根消息，或按已知的 thread_id（两者任一匹配即可）。
 */
export interface ThreadAnchor {
  chatId: string
  threadId?: string
  rootMessageId: string
}

export interface GitHubRef { owner: string; repo: string; kind: 'issue' | 'pull'; number: number; url: string }
export type GitHubItemState =
  | { status: 'read'; kind: 'issue' | 'pull'; state: 'open' | 'closed'; merged: boolean; stateReason: string | null }
  | { status: 'unavailable'; reason: string }

export interface CompletionEvidencePorts {
  /** 同一话题里 sinceMs 之后的消息：root_id = rootMessageId，或 thread_id = threadId（给了的话）；按时间正序。 */
  threadMessages(anchor: ThreadAnchor, sinceMs: number): ThreadMessage[]
  /** 这个人现在还能读这个会话（仍在群里、群允许读取）。私聊来源也会问一次。 */
  canRead(chatId: string, openId: string): boolean
  /** 读一个 Issue / PR 的当前状态；没有配置 GitHub 时不传。 */
  readGitHub?(ref: GitHubRef): Promise<GitHubItemState>
}

export type CompletionEvidenceItem =
  | { key: string; kind: 'thread_statement'; done: true; messageId: string; chatId: string; byOwner: boolean; at: number; plain: boolean }
  | { key: string; kind: 'github'; done: boolean; ref: string; url: string; itemKind: 'issue' | 'pull'; state: 'open' | 'closed' | 'unavailable'; merged: boolean; stateReason: string | null }

export interface CompletionAssessment {
  todoId: number
  verdict: 'definite' | 'probable' | 'none'
  /** 只含支持完成的证据（没做完的链接不算证据，但会让“全部链接都完成”不成立） */
  evidence: CompletionEvidenceItem[]
  /** 给人看的一句依据；definite 时必有 */
  receipt?: string
}

const CN_DONE = ['做完了', '做完啦', '做好了', '弄好了', '改好了', '写完了', '写好了', '修好了', '搞定了', '搞定啦', '已搞定',
  '已完成', '完成了', '已经完成', '已合并', '合并了', '已上线', '上线了', '已修复', '修复了', '已解决', '解决了', '已发布', '发布了']
/** 不带“了”的这些只有整句就是它时才算（“搞定！”）；带时间、人称或请求的是承诺（“今天搞定”“帮我搞定”） */
const BARE_DONE = ['搞定']
const EN_DONE = /\b(?:done|finished|completed|merged|shipped|fixed|resolved|released)\b/gi
const PARTICLES = '了啦啊呀哈咯喽喔哦嘞吧~～\\s'
/** 完成短语后面只能跟语气词，或一句致谢（“谢谢”“辛苦大家”）；“吧”放行，但整条消息因此算有保留 */
const TRAILING_OK = new RegExp(`^[${PARTICLES}]*(?:(?:谢谢|多谢|感谢|辛苦)[^${PARTICLES}]{0,3})?[${PARTICLES}]*$`)
const CHECKMARKS_ONLY = /^(?:\s*(?:✅|☑️|✔️|✔))+\s*$/
/** 判断前去掉：表情、飞书表情码（[赞]）、链接 */
const NOISE = /\p{Extended_Pictographic}|[\uFE0F\u200D]|\[[^\[\]\s]{1,8}\]|https?:\/\/\S+/gu
/** 短语前出现这些：还没做完、将来、条件、请求、反事实（“我以为”“本来”）、问句（“谁”“是不是”）——这一处不算 */
const NOT_YET = /(还没|没有|差不多|马上|就要|快要|即将|准备|打算|计划|预计|争取|回头|明天|后天|下周|稍后|一会|(?<![等相平对同])等(?![等级])|如果|要是|假如|万一|以为|本来|原本|谁|哪个|哪些|哪位|何时|什么时候|是否|有没有|是不是|\bif\b|\bwhen\b|\bonce\b|\buntil\b|\bwill\b|'ll\b|\bnot\b|n't\b|\balmost\b|\bnearly\b|\bto be\b|\bneeds?\b|\bmust\b|\bhas to\b|\bhave to\b|\bgotta\b|let (?:you|me) know|ping me|tell me)/i
/** 紧挨着短语前一个字是这些（“快做完了”“要做完了”“我来搞定”）也不算；以这些字结尾的常见名词除外 */
const NOT_YET_CHAR = /[没未不别快要会将能来去]$/
const NOT_YET_CHAR_EXCEPT = /(纪要|摘要|概要|提要|功能|性能|技能|智能|职能|例会|周会|年会|后来|原来|起来)$/
/** 句首是条件（“等上线了，……”“一旦合并了……”）：这一句不算 */
const CONDITION_START = /^(等|一旦|只要|待|直到|如果|要是|假如|万一|when\b|once\b|if\b|after\b|before\b)/i
/** 下一句以“再 / 就 / 才”开头：前一句是条件（“上线了，就通知大家”） */
const CONSEQUENCE_NEXT = /^(?:我|你|他|她|我们|你们|大家|咱们)?(?:再|就|才)/
/** 没带问号的英文问句 */
const EN_QUESTION = /^(is|are|was|were|did|do|does|has|have|can|could|will|would|should)\b/i
/** 整条消息里撤回了完成：不算 */
const RETRACT = /(其实没|并没|没做完|没完成|没弄完|没搞定|没写完|没改完|not yet|isn't done|not done|not finished)/i
/** 整条消息里有转折、剩余、主观判断、不确定、转述别人：说了完成也只能请本人确认 */
const HEDGE = /(但|不过|可是|然而|只是|还差|还剩|还在|还有|除了|剩下|其余|应该|可能|大概|估计|好像|似乎|也许|或许|吧|说|觉得|感觉|理论上|按理|按说|看起来|看来|他|她|对方|那边|人家|\bbut\b|\bstill\b|\bexcept\b|\bprobably\b|\bmaybe\b|\bi think\b|\bi guess\b|\bshould\b|\bseems?\b|\bpending\b|\bwip\b)/i
const LINK = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)/g
/** 一次判断（或 PMO 一张看板的一轮同步）最多读这么多个不同的 GitHub 链接；超出的按读不到处理（只会少认，不会多认）。 */
export const GITHUB_READ_BUDGET = 24
/** 同时最多读几个链接。 */
export const GITHUB_READ_CONCURRENCY = 6

/** 同一个 Issue / PR 的键：仓库名不分大小写。 */
export function githubRefKey(ref: Pick<GitHubRef, 'owner' | 'repo' | 'number'>): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()
}

/** 文本里写的 GitHub Issue / PR 链接，按第一次出现的顺序去重；同一编号写了几次时取最后一次的写法。 */
export function githubRefs(texts: readonly string[]): GitHubRef[] {
  const refs = new Map<string, GitHubRef>()
  for (const text of texts) {
    for (const [url, owner, repo, kind, number] of text.matchAll(LINK)) {
      if (!owner || !repo || !kind || !number) continue
      const ref: GitHubRef = { owner, repo, kind: kind === 'pull' ? 'pull' : 'issue', number: Number(number), url }
      refs.set(githubRefKey(ref), ref)
    }
  }
  return [...refs.values()]
}

/** 去重后并行读取状态：最多读 GITHUB_READ_BUDGET 个、同时最多 GITHUB_READ_CONCURRENCY 个；读失败按读不到处理，不抛错。
 * 超出上限的链接不在返回的表里，由调用方按读不到处理。 */
export function readGitHubStates(refs: readonly GitHubRef[], read: (ref: GitHubRef) => Promise<GitHubItemState>): Map<string, Promise<GitHubItemState>> {
  const out = new Map<string, Promise<GitHubItemState>>()
  let active = 0
  const waiting: (() => void)[] = []
  const limited = async (ref: GitHubRef): Promise<GitHubItemState> => {
    while (active >= GITHUB_READ_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try { return await read(ref) }
    catch (error) { return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) } }
    finally { active--; waiting.shift()?.() }
  }
  for (const ref of refs) {
    const key = githubRefKey(ref)
    if (out.has(key)) continue
    if (out.size >= GITHUB_READ_BUDGET) break
    out.set(key, limited(ref))
  }
  return out
}

/** Issue / PR 当前状态的说法；待办完成依据和 PMO「关联」列共用。 */
export function githubStateLabel(item: { kind: 'issue' | 'pull'; state: 'open' | 'closed' | 'unavailable'; merged: boolean; stateReason: string | null }): string {
  if (item.state === 'unavailable') return '未读到'
  if (item.kind === 'pull') return item.merged ? '已合并' : item.state === 'closed' ? '已关闭未合并' : '未合并'
  return item.state === 'closed' ? (item.stateReason === 'completed' ? '已关闭为完成' : item.stateReason ? `已关闭（${item.stateReason}）` : '已关闭（没有写原因）') : '未关闭'
}

export type CompletionStatement = 'plain' | 'hedged' | 'none'

/**
 * 一条消息是不是在陈述“已经做完了”。保守：完成短语必须收在句末（只跟语气词或致谢）；
 * 问句、否定、将来、条件、请求、反事实、撤回都不算；同一条消息里有转折、剩余、主观判断、不确定或转述的，只算 hedged。
 * 单独一个勾常见意思是“收到”，也只算 hedged。
 */
export function completionStatement(text: string): CompletionStatement {
  const withoutMentions = text.replace(/@\S+/g, ' ')
  if (!withoutMentions.trim()) return 'none'
  if (CHECKMARKS_ONLY.test(withoutMentions)) return 'hedged'
  if (RETRACT.test(withoutMentions)) return 'none'
  const clauses: { body: string; question: boolean }[] = []
  for (const line of withoutMentions.replace(NOISE, ' ').split(/\n+/)) {
    for (const piece of line.replace(/\s+/g, ' ').split(/(?<=[，,。.!！;；？?])/)) {
      const clause = piece.trim()
      const body = clause.replace(/[，,。.!！;；？?]+$/, '').trim()
      if (body) clauses.push({ body, question: /[?？]$/.test(clause) })
    }
  }
  const stated = clauses.some(({ body, question }, i) => {
    if (question || /(吗|么|呢|没|没有)$/.test(body) || EN_QUESTION.test(body) || CONDITION_START.test(body)) return false
    if (CONSEQUENCE_NEXT.test(clauses[i + 1]?.body ?? '')) return false
    return endsWithCompletion(body)
  })
  if (!stated) return 'none'
  return HEDGE.test(withoutMentions) ? 'hedged' : 'plain'
}

function endsWithCompletion(body: string): boolean {
  const hits: number[] = []
  const lower = body.toLowerCase()
  for (const phrase of CN_DONE) {
    const at = lower.lastIndexOf(phrase)
    if (at >= 0 && TRAILING_OK.test(lower.slice(at + phrase.length))) hits.push(at)
  }
  for (const phrase of BARE_DONE) {
    if (lower.startsWith(phrase) && TRAILING_OK.test(lower.slice(phrase.length))) hits.push(0)
  }
  for (const match of lower.matchAll(EN_DONE)) {
    if (match.index !== undefined && TRAILING_OK.test(lower.slice(match.index + match[0].length))) hits.push(match.index)
  }
  return hits.some(at => {
    const before = lower.slice(0, at).trimEnd()
    if (NOT_YET.test(before)) return false
    return NOT_YET_CHAR_EXCEPT.test(before) || !NOT_YET_CHAR.test(before)
  })
}

/** 只建新表，不改已有表；升级脚本单独调用它做两遍迁移核对。 */
export function ensureTodoCompletionEvidenceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS todo_completion_evidence (
    todo_id INTEGER NOT NULL,
    evidence_key TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (todo_id, evidence_key)
  )`)
}

export class TodoCompletionEvidence {
  constructor(private readonly db: DatabaseSync, private readonly ports: CompletionEvidencePorts) {
    ensureTodoCompletionEvidenceSchema(db)
  }

  /** 同一事务里和 TodoApplication 的“标完成”一起调用：记下用过的证据，本人改回未完成后不再用它。 */
  recordApplied(todoId: number, keys: readonly string[], nowMs = Date.now()): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO todo_completion_evidence (todo_id, evidence_key, applied_at) VALUES (?, ?, ?)')
    for (const key of keys) insert.run(todoId, key, nowMs)
  }

  /** 一个人名下的未完成待办，逐条给结论。只读（GitHub 读取除外），不改任何待办。 */
  async assess(ownerOpenId: string, subjects: readonly CompletionSubject[]): Promise<CompletionAssessment[]> {
    const mine = subjects.filter(subject => subject.ownerOpenId === ownerOpenId)
    const statements = this.threadStatements(ownerOpenId, mine)
    const out: CompletionAssessment[] = []
    for (const subject of mine) {
      const used = this.applied(subject.id)
      const thread = (statements.get(subject.id) ?? []).filter(item => !used.has(item.key))
      // “链接是否全部完成”看全部链接；用过的证据只是不能再当作新依据
      const github = await this.githubEvidence(subject)
      out.push(conclude(subject.id, thread, github, used))
    }
    return out
  }

  private applied(todoId: number): Set<string> {
    return new Set((this.db.prepare('SELECT evidence_key FROM todo_completion_evidence WHERE todo_id = ?').all(todoId) as { evidence_key: string }[])
      .map(row => row.evidence_key))
  }

  /** 每条陈述只归到它说出时已经存在的、同一话题里本人的未完成待办；不止一条时都只算 probable。 */
  private threadStatements(ownerOpenId: string, subjects: readonly CompletionSubject[]): Map<number, (CompletionEvidenceItem & { kind: 'thread_statement'; unique: boolean })[]> {
    const byAnchor = new Map<string, { anchor: ThreadAnchor; subjects: CompletionSubject[] }>()
    for (const subject of subjects) {
      const anchor = anchorOf(subject.source)
      if (!anchor) continue
      const key = `${anchor.chatId}\u0000${anchor.rootMessageId}`
      const group = byAnchor.get(key) ?? { anchor, subjects: [] }
      // 根消息上记的待办没有 thread_id，话题里记的有：同一话题取任一已知的 thread_id
      if (!group.anchor.threadId && anchor.threadId) group.anchor = { ...group.anchor, threadId: anchor.threadId }
      group.subjects.push(subject)
      byAnchor.set(key, group)
    }
    const out = new Map<number, (CompletionEvidenceItem & { kind: 'thread_statement'; unique: boolean })[]>()
    for (const { anchor, subjects: group } of byAnchor.values()) {
      if (!this.ports.canRead(anchor.chatId, ownerOpenId)) continue
      const since = Math.min(...group.map(subject => subject.createdAt))
      const sources = new Set(group.map(subject => subject.source!.messageId))
      for (const message of this.ports.threadMessages(anchor, since)) {
        if (message.chatId !== anchor.chatId || sources.has(message.messageId)) continue
        const statement = completionStatement(message.text)
        if (statement === 'none') continue
        const candidates = group.filter(subject => subject.createdAt < message.createTimeMs)
        for (const subject of candidates) {
          const list = out.get(subject.id) ?? []
          list.push({ key: `message:${message.messageId}`, kind: 'thread_statement', done: true, messageId: message.messageId, chatId: message.chatId,
            byOwner: message.senderOpenId === ownerOpenId, at: message.createTimeMs, plain: statement === 'plain', unique: candidates.length === 1 })
          out.set(subject.id, list)
        }
      }
    }
    return out
  }

  private async githubEvidence(subject: CompletionSubject): Promise<(CompletionEvidenceItem & { kind: 'github' })[]> {
    const refs = githubRefs([subject.title, subject.detail ?? ''])
    if (!refs.length) return []
    const out: (CompletionEvidenceItem & { kind: 'github' })[] = []
    for (const ref of refs) {
      const name = `${ref.owner}/${ref.repo}#${ref.number}`
      const state = this.ports.readGitHub ? await this.ports.readGitHub(ref) : { status: 'unavailable' as const, reason: 'GitHub 未配置' }
      if (state.status !== 'read') {
        out.push({ key: `github:${name.toLowerCase()}`, kind: 'github', done: false, ref: name, url: ref.url, itemKind: ref.kind, state: 'unavailable', merged: false, stateReason: null })
        continue
      }
      const done = state.kind === 'pull' ? state.merged : state.state === 'closed' && state.stateReason === 'completed'
      out.push({ key: `github:${name.toLowerCase()}`, kind: 'github', done, ref: name, url: ref.url, itemKind: state.kind, state: state.state, merged: state.merged, stateReason: state.stateReason })
    }
    return out
  }
}

function anchorOf(source: TodoMessageMetadata | null): ThreadAnchor | undefined {
  if (!source) return undefined
  return { chatId: source.chatId, ...(source.threadId ? { threadId: source.threadId } : {}), rootMessageId: source.rootId ?? source.messageId }
}

function conclude(todoId: number, thread: (CompletionEvidenceItem & { kind: 'thread_statement'; unique: boolean })[],
  github: (CompletionEvidenceItem & { kind: 'github' })[], used: ReadonlySet<string>): CompletionAssessment {
  const strip = ({ unique: _unique, ...item }: CompletionEvidenceItem & { unique?: boolean }) => item as CompletionEvidenceItem
  const ownWords = thread.filter(item => item.byOwner && item.unique && item.plain)
  const fresh = github.filter(item => !used.has(item.key))
  const githubDone = fresh.filter(item => item.done)
  const allLinksDone = github.length > 0 && github.every(item => item.done) && githubDone.length > 0
  // 关闭但没写原因的 Issue（旧 Issue 或 API 没给原因）只当线索
  const closedWithoutReason = fresh.filter(item => item.itemKind === 'issue' && item.state === 'closed' && item.stateReason === null)
  const evidence = [...thread.map(strip), ...githubDone.map(strip), ...closedWithoutReason.map(strip)]
  if (ownWords.length || allLinksDone) {
    const receipt = ownWords.length ? '依据：你在这条待办的原话题里说已经完成'
      : `依据：${githubDone.map(item => `${item.ref}${item.itemKind === 'pull' ? ' 已合并' : ' 已关闭为完成'}`).join('，')}`
    return { todoId, verdict: 'definite', evidence, receipt }
  }
  return { todoId, verdict: evidence.length ? 'probable' : 'none', evidence }
}
