import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { decisionRef, type Inbox } from './inbox.js'
import type { IssueNotice, IssueWatch, IssueWatchBinding } from './issue-watch.js'
import type { IssueThread, IssueValidityAssessment } from '../github/issue-thread.js'
import { escapeForCard } from '../feishu/cards.js'

export type ValidityState = 'pending' | 'sent' | 'unknown' | 'confirmed' | 'not_needed' | 'expired' | 'invalidated'
/** 提出者或参与者：成员表对应到当前群成员的才有 openId（卡片里 @）；只知道姓名就写姓名；都不知道写 GitHub 登录名。 */
export interface IssueValidityPerson { role: 'author' | 'participant'; login: string; name?: string; openId?: string }
export interface IssueValidityRequest {
  id: string; spaceId: string; chatId: string; requesterOpenId: string; binding: string
  repo: string; number: number; title: string; url: string; digest: string
  evidence: { ref: string; quote: string }[]; state: ValidityState; messageId?: string
  createdAt: number; expiresAt: number; decisionRef: number; replyId?: string
  /** 提醒时 Issue 上的标签集合（排序去重），识别提醒之后人改的标签用；本项之前的快照没有 */
  labels?: string[]
  /** 评估时从线程原文认出的仓库内路径，“仍有效”时按 CODEOWNERS 找负责人用 */
  paths?: string[]
  people?: IssueValidityPerson[]
  /** “仍有效”的待决断记在谁名下（规则负责人、可信用户或绑定负责人）；答复之前没有 */
  decisionOwnerOpenId?: string
}

/**
 * “仍有效”时待决断交给谁（2026-09-25 定）：
 *   rule      负责人规则唯一命中（CODEOWNERS + 成员表 + 当前群成员），直接给他
 *   trusted   判断不了（多候选、没有路径、对应不到人），交给部署配置的第一位可信用户
 *   requester 没有配置可信用户时回退绑定负责人
 */
export interface IssueValidityHandoff {
  ownerOpenId: string
  basis: 'rule' | 'trusted' | 'requester'
  owner?: { login: string; name?: string }
  reason?: string
}

/** 最多列 1 个提出者加这么多参与者；再多的人卡片放不下，也不是核实要找的人。 */
export const MAX_VALIDITY_PARTICIPANTS = 5

/** Durable notification reservation and human attestation; no GitHub write capability. */
export class IssueValidityRequests {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS issue_validity_requests (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, message_id TEXT UNIQUE, state TEXT NOT NULL,
      snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`)
  }

  get(id: string): IssueValidityRequest | undefined {
    const row = this.db.prepare('SELECT snapshot FROM issue_validity_requests WHERE id = ?').get(id) as { snapshot: string } | undefined
    return row ? JSON.parse(row.snapshot) : undefined
  }
  byMessage(messageId: string): IssueValidityRequest | undefined {
    const row = this.db.prepare('SELECT snapshot FROM issue_validity_requests WHERE message_id = ?').get(messageId) as { snapshot: string } | undefined
    return row ? JSON.parse(row.snapshot) : undefined
  }
  /** 这个空间就这张 Issue 最近一次发出的提醒（含回执未知的）；识别提醒之后人改的标签用。 */
  latestReminder(spaceId: string, repo: string, number: number): IssueValidityRequest | undefined {
    const row = this.db.prepare(`SELECT snapshot FROM issue_validity_requests WHERE space_id = ? AND state <> 'pending'
      AND json_extract(snapshot, '$.repo') = ? AND json_extract(snapshot, '$.number') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(spaceId, repo, number) as { snapshot: string } | undefined
    return row ? JSON.parse(row.snapshot) : undefined
  }
  reserve(watch: IssueWatch, binding: IssueWatchBinding, bindingRaw: string, chatId: string, thread: IssueThread,
    assessment: Extract<IssueValidityAssessment, { verdict: 'ask' }>, notice: IssueNotice, people: IssueValidityPerson[] = []): IssueValidityRequest | undefined {
    const now = this.now(), id = randomUUID()
    const request: IssueValidityRequest = { id, spaceId: binding.spaceId, chatId, requesterOpenId: binding.boundBy, binding: bindingRaw,
      repo: binding.repo, number: thread.snapshot.number, title: thread.snapshot.title, url: thread.snapshot.url,
      digest: thread.digest, evidence: assessment.evidence, state: 'pending', createdAt: now, expiresAt: now + 7 * 86400_000,
      decisionRef: decisionRef(binding.spaceId, `issue-validity:${id}`),
      labels: normalizeLabels(thread.snapshot.labels), paths: assessment.paths, people }
    this.db.exec('SAVEPOINT reserve_issue_validity')
    try {
      if (!watch.claim(binding.spaceId, binding.repo, request.number, { again: notice.again, previousNoticeAt: notice.previousNoticeAt })) {
        this.db.exec('RELEASE SAVEPOINT reserve_issue_validity'); return undefined
      }
      this.db.prepare('INSERT INTO issue_validity_requests(id,space_id,state,snapshot,created_at,expires_at) VALUES(?,?,?,?,?,?)')
        .run(id, request.spaceId, request.state, JSON.stringify(request), now, request.expiresAt)
      this.db.exec('RELEASE SAVEPOINT reserve_issue_validity')
      return request
    } catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT reserve_issue_validity; RELEASE SAVEPOINT reserve_issue_validity'); throw error }
  }
  sent(id: string, messageId: string): void {
    const value = this.get(id)
    if (!value || value.state !== 'pending' || !messageId.trim()) throw new Error('issue notice acknowledgment unavailable')
    this.save({ ...value, messageId, state: 'sent' })
  }
  invalidate(id: string, state: 'unknown' | 'expired' | 'invalidated'): void {
    const value = this.get(id)
    if (value && ['pending', 'sent'].includes(value.state)) this.save({ ...value, state })
  }
  /**
   * Decision and the one-use answer are committed together; a replay cannot create another pending item.
   * “仍有效”的待决断按 `handoff` 记在规则负责人、可信用户或绑定负责人名下；不给 handoff 就记给绑定负责人。
   */
  answer(id: string, choice: 'effective' | 'not_needed', replyId: string, inbox: Inbox, assertCurrent: () => void, handoff?: IssueValidityHandoff): boolean {
    this.db.exec('SAVEPOINT answer_issue_validity')
    try {
      assertCurrent()
      const value = this.get(id)
      if (!value || value.state !== 'sent' || value.expiresAt <= this.now()) {
        this.db.exec('RELEASE SAVEPOINT answer_issue_validity'); return false
      }
      const owner = handoff ?? { ownerOpenId: value.requesterOpenId, basis: 'requester' as const }
      if (choice === 'effective') {
        const text = issueValidityDecisionText(value, owner)
        inbox.add({ ownerOpenId: owner.ownerOpenId, kind: 'decision', refId: value.decisionRef, spaceId: value.spaceId,
          title: text.title, why: text.why, now: this.now() })
      }
      this.save({ ...value, state: choice === 'effective' ? 'confirmed' : 'not_needed', replyId,
        ...(choice === 'effective' ? { decisionOwnerOpenId: owner.ownerOpenId } : {}) })
      this.db.exec('RELEASE SAVEPOINT answer_issue_validity')
      return true
    } catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT answer_issue_validity; RELEASE SAVEPOINT answer_issue_validity'); throw error }
  }
  forDecision(ref: number): IssueValidityRequest | undefined {
    return (this.db.prepare("SELECT snapshot FROM issue_validity_requests WHERE state = 'confirmed'").all() as { snapshot: string }[])
      .map(row => JSON.parse(row.snapshot) as IssueValidityRequest).find(value => value.decisionRef === ref)
  }
  private save(value: IssueValidityRequest): void {
    this.db.prepare('UPDATE issue_validity_requests SET snapshot=?,state=?,message_id=? WHERE id=?')
      .run(JSON.stringify(value), value.state, value.messageId ?? null, value.id)
  }
}

/** GitHub 标题、原文、成员表姓名是外部文字：去掉尖括号，免得在待决断或回复里拼出 <at> 标记。 */
function plainText(text: string): string {
  return text.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim()
}

function clipText(text: string, max: number): string {
  const one = plainText(text)
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one
}

/**
 * “仍有效”的待决断文案：标题不变；说明写清交给他的依据、一段线程原文引文和指向该处的链接。
 * 说明不超过 Inbox 的 300 字：链接只整条放，放不下先缩引文，再去掉引文。
 */
export function issueValidityDecisionText(value: IssueValidityRequest, handoff: IssueValidityHandoff): { title: string; why: string } {
  const title = `已核实仍有效：${value.repo}#${value.number}，请决定下一步`
  const reason = handoff.reason ? plainText(handoff.reason) : ''
  const lead = handoff.basis === 'rule'
    ? `按 CODEOWNERS，涉及的路径${value.paths?.length ? `（${clipText(value.paths.join('、'), 60)}）` : ''}归你（GitHub ${plainText(handoff.owner?.login ?? '')}）；开启关注的负责人已向提出者核实仍有效`
    : handoff.basis === 'trusted' ? `没有唯一负责人（${reason}），交给你定；开启关注的负责人已向提出者核实仍有效`
    : reason ? `没有唯一负责人（${reason}），也没有配置可信用户；负责人已向提出者核实仍有效`
    : '负责人已向提出者核实；完整线程证据见原群确认卡'
  const first = value.evidence[0]
  const link = first && first.ref.startsWith('comment:') ? `${value.url}#issuecomment-${first.ref.slice(8)}` : value.url
  const LIMIT = 300
  const withQuote = (quote: string) => `${lead}。${first ? `${first.ref === 'body' ? '提出者正文' : '评论'}原文：「${quote}」 ` : ''}${link}`
  if (first) {
    const room = LIMIT - withQuote('').length
    if (room >= 10) return { title, why: withQuote(clipText(first.quote, room)) }
  }
  const bare = `${lead}。${link}`
  if (bare.length <= LIMIT) return { title, why: bare }
  const short = `${lead}。${value.url}`
  return { title, why: short.length <= LIMIT ? short : `${clipText(lead, LIMIT - value.url.length - 2)}。${value.url}` }
}

/** Explicit reply protocol shown on the card; unknown wording cannot become authorization through guessing. */
export function issueValidityReply(text: string): 'effective' | 'not_needed' | undefined {
  const value = text.trim().replace(/[。.!！]$/, '').replace(/：/g, ':').replace(/\s/g, '')
  return value === '已核实:仍有效' ? 'effective' : value === '已核实:不再需要' ? 'not_needed' : undefined
}

/** 卡片里的一个人：对应到本群成员的原样 @；否则写姓名（带 GitHub 登录名）；连姓名也没有就只写登录名。 */
function personText(person: IssueValidityPerson): string {
  if (person.openId && /^ou_[A-Za-z0-9]+$/.test(person.openId)) return `<at id="${person.openId}"></at>`
  const login = escapeForCard(person.login)
  return person.name ? `${escapeForCard(person.name)}（GitHub ${login}）` : `GitHub ${login}`
}

export function issueValidityCard(request: IssueValidityRequest): Record<string, unknown> {
  const plain = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } })
  const md = (content: string) => ({ tag: 'markdown', content })
  const button = (text: string, choice: string) => ({ tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default',
    behaviors: [{ type: 'callback', value: { action: 'issue_validity', id: request.id, choice, digest: request.digest } }] })
  const people = request.people ?? []
  const authors = people.filter(p => p.role === 'author'), participants = people.filter(p => p.role === 'participant')
  const mentioned = people.some(p => p.openId)
  const peopleLine = people.length
    ? [md(`提出者：${authors.map(personText).join('、') || '未知'}${participants.length ? `；参与者：${participants.map(personText).join('、')}` : ''}`)]
    : []
  const mapping = mentioned ? '已按成员表把提出者、参与者对应到本群成员并 @；对应不上或不在本群的只写名字。'
    : '成员表里没有这些账号对应的本群成员，或没有配置成员表：只写名字，不 @。'
  return { schema: '2.0', config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '这条问题还有效吗？' }, template: 'blue' },
    body: { elements: [plain(`${request.repo}#${request.number}「${request.title}」\n${request.url}`),
      plain('已读取完整正文、评论和时间线，发现需要人工核实的线索。未按天数判断问题失效，也未接单。'),
      ...peopleLine,
      ...request.evidence.map(item => plain(`${item.ref === 'body' ? '提出者正文' : '评论'}原文：\n${item.quote}\n${request.url}${item.ref === 'body' ? '' : '#issuecomment-' + item.ref.slice(8)}`)),
      plain(`${mapping}请开启这项关注的负责人向提出者核实后确认；只有该负责人可以处理。确认仍有效后，会按负责人规则交给合适的人决断（判断不了时交给部署配置的可信用户）。确认在七天后过期；讨论、标签或绑定变化后需重新核验。`),
      button('已核实：仍有效', 'effective'), button('已核实：不再需要', 'not_needed'),
      plain('也可以直接回复本卡片：已核实：仍有效，或 已核实：不再需要。其他答复不会被当成确认。') ] } }
}

// ---- 提醒之后人改的标签 ----

/** kv `issue-label-correction:<repo>#<n>` 的值：提醒时与更正后的标签集合与时间。 */
export interface IssueLabelCorrection {
  repo: string; number: number; spaceId: string; requestId: string
  remindedAt: number; remindedLabels: string[]
  correctedAt: number; correctedLabels: string[]
  /** 更正时 Issue 的状态；之后关闭再重开算状态变化 */
  state: 'open' | 'closed'
}

export function issueLabelCorrectionKey(repo: string, number: number): string {
  return `issue-label-correction:${repo}#${number}`
}

export function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map(label => label.trim()).filter(Boolean))].sort()
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, index) => label === b[index])
}

export function parseLabelCorrection(raw: string | undefined): IssueLabelCorrection | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<IssueLabelCorrection>
    if (typeof value?.requestId !== 'string' || !Array.isArray(value.remindedLabels) || !Array.isArray(value.correctedLabels)
      || !Number.isFinite(value.correctedAt) || (value.state !== 'open' && value.state !== 'closed')) return undefined
    return value as IssueLabelCorrection
  } catch { return undefined }
}

/** 更正之后 Issue 状态有没有变过：时间线里 sinceMs 之后的 closed / reopened 事件。 */
export function issueStateChangedSince(timeline: readonly Record<string, unknown>[], sinceMs: number): boolean {
  return timeline.some(event => (event.event === 'closed' || event.event === 'reopened')
    && typeof event.created_at === 'string' && Date.parse(event.created_at) > sinceMs)
}

export type LabelCorrectionStep = { action: 'skip' } | { action: 'record'; record: IssueLabelCorrection } | { action: 'evaluate' }

/**
 * 提醒之后的标签更正怎么影响这一轮：
 *   record   这一轮第一次发现标签集合与提醒时不同：记下来，本轮不按旧判断重复提醒
 *   skip     记录过的更正仍然成立（标签与更正后相同、状态没变）：不重新评估
 *   evaluate 没提醒过、标签与提醒时相同、或更正之后标签再次变化 / 状态变化：照常评估
 */
export function labelCorrectionStep(input: { reminder: IssueValidityRequest | undefined; record: IssueLabelCorrection | undefined; thread: IssueThread; now: number }): LabelCorrectionStep {
  const { reminder, record, thread } = input
  if (!reminder?.labels) return { action: 'evaluate' }
  const current = normalizeLabels(thread.snapshot.labels)
  if (record && record.requestId === reminder.id) {
    const unchanged = sameLabels(record.correctedLabels, current) && record.state === thread.snapshot.state
      && !issueStateChangedSince(thread.timeline, record.correctedAt)
    return { action: unchanged ? 'skip' : 'evaluate' }
  }
  if (sameLabels(normalizeLabels(reminder.labels), current)) return { action: 'evaluate' }
  return { action: 'record', record: { repo: reminder.repo, number: reminder.number, spaceId: reminder.spaceId, requestId: reminder.id,
    remindedAt: reminder.createdAt, remindedLabels: normalizeLabels(reminder.labels), correctedAt: input.now, correctedLabels: current, state: thread.snapshot.state } }
}
