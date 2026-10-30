/** 已有反馈案件的信息性补问。原始答复留在真实入站 Task；这里不授予读取或业务动作权限。 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Bugs, MAX_FOLLOWUP_ASKS, isBugInfoKind, type BugBucket, type BugDeclinedInfo, type BugInfoKind, type BugMessageAnchor, type BugReport } from './bugs.js'

export type BugQuestionResolution = 'open' | 'answered' | 'declined' | 'cancelled'
export type BugQuestionReplyOutcome = 'pending' | 'answered' | 'declined' | 'unavailable'

export interface BugQuestionInput {
  bucketId: number
  spaceId: string
  sessionKey: string
  originTaskId: number
  targetOpenId: string
  anchor: { tenantId: string; appId: string; chatId: string; messageId: string; threadId?: string; rootId?: string; parentId?: string }
  kind: 'info'
  question: string
  missingInfo?: string[]
  /** 所要材料的类别；本案已有已拒绝材料记录时必须给出。 */
  infoKind?: BugInfoKind
}

export interface BugQuestion {
  id: number
  bucketId: number
  spaceId: string
  sessionKey: string
  originTaskId: number
  targetOpenId: string
  anchorId: number
  kind: 'info'
  question: string
  missingInfo: string[]
  /** 旧问题和未标明类别的问题为 null。 */
  infoKind: BugInfoKind | null
  deliveryKey: string
  resolution: BugQuestionResolution
  createdAt: number
}

export interface BugQuestionReply {
  id: number
  questionId: number
  messageId: string
  senderOpenId: string
  taskId: number
  outcome: BugQuestionReplyOutcome
  createdAt: number
  resolvedAt: number | null
}

export interface BugQuestionContext {
  bucket: BugBucket
  reports: BugReport[]
  reportsTruncated: boolean
  questions: (BugQuestion & {
    origin: { taskId: number; messageId: string | null; text: string | null }
    replies: (BugQuestionReply & { text: string | null })[]
  })[]
}

/** 宿主拒绝登记补问的明确原因。其余前置条件失败仍抛普通 Error。 */
export class BugQuestionError extends Error {
  constructor(readonly code: 'declined_before' | 'info_kind_required', message: string, readonly declined: BugDeclinedInfo[]) {
    super(message)
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bug_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL REFERENCES bug_buckets(id),
  space_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  origin_task_id INTEGER NOT NULL REFERENCES tasks(id),
  target_open_id TEXT NOT NULL,
  anchor_id INTEGER NOT NULL REFERENCES bug_message_anchors(id),
  kind TEXT NOT NULL CHECK(kind = 'info'),
  question TEXT NOT NULL,
  missing_info TEXT NOT NULL,
  input_signature TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution IN ('open','answered','declined','cancelled')),
  created_at INTEGER NOT NULL,
  UNIQUE(bucket_id, origin_task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bug_question_open ON bug_questions(bucket_id) WHERE resolution = 'open';
CREATE TABLE IF NOT EXISTS bug_question_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES bug_questions(id),
  message_id TEXT NOT NULL UNIQUE,
  sender_open_id TEXT NOT NULL,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','answered','declined','unavailable')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bug_question_replies ON bug_question_replies(question_id, id);
`

export class BugQuestions {
  constructor(private readonly db: DatabaseSync, private readonly bugs: Bugs) {
    db.exec(SCHEMA)
    // 旧问题保持 NULL：不从问题文字推断材料类别。
    const cols = new Set((db.prepare('PRAGMA table_info(bug_questions)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('info_kind')) db.exec('ALTER TABLE bug_questions ADD COLUMN info_kind TEXT')
  }

  prepare(input: BugQuestionInput): BugQuestion {
    if (input.kind !== 'info') throw new Error('当前仅支持信息性补问，decision 尚未开放')
    const normalized = normalizeInput(input)
    const signature = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    return this.transaction(() => {
      this.requireBucket(normalized.bucketId, normalized.spaceId)
      if (this.bugs.get(normalized.bucketId)?.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能新增补问')
      this.requireInbound(normalized.originTaskId, normalized.sessionKey, normalized.targetOpenId, normalized.anchor.messageId, normalized.anchor.chatId)
      const prior = this.db.prepare('SELECT * FROM bug_questions WHERE bucket_id = ? AND origin_task_id = ?')
        .get(normalized.bucketId, normalized.originTaskId) as Row | undefined
      if (prior) {
        if (prior.input_signature !== signature) throw new Error('本任务已经登记其他补问，不能改写问题或目标')
        return toQuestion(prior)
      }
      if (this.db.prepare("SELECT 1 FROM bug_questions WHERE bucket_id = ? AND resolution = 'open'").get(normalized.bucketId)) throw new Error('本案已有未处理的补问，请先查看已有问题和答复')
      if (this.budget(normalized.bucketId).occupied >= MAX_FOLLOWUP_ASKS) throw new Error('本案补问额度已用完，不会新增问题')
      // 用户已说过不提供的类别不再索要；类别由调用方标明，宿主不从问题文字推断。
      const declined = this.bugs.get(normalized.bucketId)!.declinedInfo
      if (declined.length && normalized.infoKind === undefined) throw new BugQuestionError('info_kind_required', '本案已记录用户不提供的材料，补问须标明 info_kind', declined)
      const refused = declined.filter((entry) => entry.kind === normalized.infoKind)
      if (refused.length) throw new BugQuestionError('declined_before', '用户之前已表示不提供这类材料，不再发出同类补问', refused)
      const anchor = this.bugs.addAnchor({ ...normalized.anchor, bucketId: normalized.bucketId, spaceId: normalized.spaceId })
      const result = this.db.prepare(`INSERT INTO bug_questions
        (bucket_id, space_id, session_key, origin_task_id, target_open_id, anchor_id, kind, question, missing_info, input_signature, resolution, created_at, info_kind)
        VALUES (?, ?, ?, ?, ?, ?, 'info', ?, ?, ?, 'open', ?, ?)`).run(
        normalized.bucketId, normalized.spaceId, normalized.sessionKey, normalized.originTaskId, normalized.targetOpenId,
        anchor.id, normalized.question, JSON.stringify(normalized.missingInfo), signature, Date.now(), normalized.infoKind ?? null,
      )
      return this.get(Number(result.lastInsertRowid))!
    })
  }

  /** get/replies/forTask 是可信宿主接口；面向模型前须先按 spaceId 调用 list 授权筛选。 */
  get(id: number): BugQuestion | undefined {
    const row = this.db.prepare('SELECT * FROM bug_questions WHERE id = ?').get(id) as Row | undefined
    return row ? toQuestion(row) : undefined
  }

  list(bucketId: number, spaceId: string): BugQuestion[] {
    this.requireBucket(bucketId, spaceId)
    return (this.db.prepare('SELECT * FROM bug_questions WHERE bucket_id = ? AND space_id = ? ORDER BY id').all(bucketId, spaceId) as Row[]).map(toQuestion)
  }

  /** 本案最新阶段 / Issue 与真实历史原文；不复制正文、补摘要或修改接单状态。 */
  readContext(bucketId: number, spaceId: string): BugQuestionContext {
    const questions = this.list(bucketId, spaceId)
    const reports = this.bugs.reports(bucketId, 51)
    const taskText = this.db.prepare('SELECT message_id, prompt FROM tasks WHERE id = ? AND session_key = ?')
    return {
      bucket: this.bugs.get(bucketId)!,
      reports: reports.slice(0, 50),
      reportsTruncated: reports.length > 50,
      questions: questions.map((question) => {
        const origin = taskText.get(question.originTaskId, question.sessionKey) as { message_id: string; prompt: string } | undefined
        return {
          ...question,
          origin: { taskId: question.originTaskId, messageId: origin?.message_id ?? null, text: origin?.prompt ?? null },
          replies: this.replies(question.id).map((reply) => {
            const task = taskText.get(reply.taskId, question.sessionKey) as { prompt: string } | undefined
            return { ...reply, text: task?.prompt ?? null }
          }),
        }
      }),
    }
  }

  budget(bucketId: number): { occupied: number; max: number } {
    const bucket = this.bugs.get(bucketId)
    if (!bucket) throw new Error('没有这条反馈')
    // 旧 asks 保留为历史预占；任何 Delivery 都可能已开始发送，取消也不能退额。
    const delivery = this.hasDeliveries() ? " OR EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_key = 'question:' || q.id)" : ''
    const row = this.db.prepare(`SELECT count(*) AS n FROM bug_questions q WHERE q.bucket_id = ? AND (q.resolution != 'cancelled'${delivery})`).get(bucketId) as { n: number }
    return { occupied: bucket.asks + Number(row.n), max: MAX_FOLLOWUP_ASKS }
  }

  cancel(id: number): BugQuestion | undefined {
    this.db.prepare("UPDATE bug_questions SET resolution = 'cancelled' WHERE id = ? AND resolution != 'cancelled'").run(id)
    return this.get(id)
  }

  cancelForFeedback(bucketId: number, spaceId: string): number {
    this.requireBucket(bucketId, spaceId)
    return Number(this.db.prepare("UPDATE bug_questions SET resolution = 'cancelled' WHERE bucket_id = ? AND resolution != 'cancelled'").run(bucketId).changes)
  }

  listForTask(taskId: number): BugQuestion[] {
    return (this.db.prepare('SELECT * FROM bug_questions WHERE origin_task_id = ? ORDER BY id').all(taskId) as Row[]).map(toQuestion)
  }

  /** 明确停止当前任务时调用；只取消它发起或处理的问题，保留历史答复与发送事实。 */
  cancelForTask(taskId: number): number {
    return Number(this.db.prepare(`UPDATE bug_questions SET resolution = 'cancelled'
      WHERE resolution != 'cancelled' AND (origin_task_id = ? OR id IN (SELECT question_id FROM bug_question_replies WHERE task_id = ?))`)
      .run(taskId, taskId).changes)
  }

  getAnchor(anchorId: number): BugMessageAnchor | undefined {
    const row = this.db.prepare('SELECT bucket_id FROM bug_message_anchors WHERE id = ?').get(anchorId) as { bucket_id: number } | undefined
    const bucket = row ? this.bugs.get(row.bucket_id) : undefined
    return bucket ? this.bugs.anchors(bucket.id, bucket.spaceId).find((anchor) => anchor.id === anchorId) : undefined
  }

  /** 仅启动且没有活动发送者时调用；不补发、也不修改任何 Delivery。 */
  recoverUnsent(): number {
    const delivery = this.hasDeliveries() ? " AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_key = 'question:' || bug_questions.id)" : ''
    return Number(this.db.prepare(`UPDATE bug_questions SET resolution = 'cancelled' WHERE resolution = 'open'${delivery}`).run().changes)
  }

  findForReply(input: { spaceId: string; tenantId: string; appId: string; chatId: string; parentId: string; targetOpenId: string; includeCancelled?: boolean }): BugQuestion | undefined {
    if (!this.hasDeliveries()) return undefined
    const rows = this.db.prepare(`SELECT q.* FROM bug_questions q
      JOIN bug_buckets b ON b.id = q.bucket_id AND b.space_id = q.space_id
      JOIN bug_message_anchors a ON a.id = q.anchor_id AND a.bucket_id = q.bucket_id
      JOIN deliveries d ON d.delivery_key = 'question:' || q.id
      WHERE q.space_id = ? AND a.tenant_id = ? AND a.app_id = ? AND a.chat_id = ?
        AND d.remote_id = ? AND d.status IN ('sent','confirmed') AND q.target_open_id = ? AND (? OR q.resolution != 'cancelled')
      ORDER BY q.id LIMIT 2`).all(input.spaceId, input.tenantId, input.appId, input.chatId, input.parentId, input.targetOpenId, Number(input.includeCancelled === true)) as Row[]
    return rows.length === 1 ? toQuestion(rows[0]!) : undefined
  }

  unsettled(input: { spaceId: string; tenantId: string; appId: string; chatId: string; targetOpenId: string }): BugQuestion[] {
    if (!this.hasDeliveries()) return []
    return (this.db.prepare(`SELECT q.* FROM bug_questions q
      JOIN bug_buckets b ON b.id = q.bucket_id AND b.space_id = q.space_id
      JOIN bug_message_anchors a ON a.id = q.anchor_id AND a.bucket_id = q.bucket_id
      JOIN deliveries d ON d.delivery_key = 'question:' || q.id
      WHERE q.space_id = ? AND a.tenant_id = ? AND a.app_id = ? AND a.chat_id = ? AND q.target_open_id = ?
        AND d.status IN ('planned','unknown') AND q.resolution != 'cancelled' ORDER BY q.id`)
      .all(input.spaceId, input.tenantId, input.appId, input.chatId, input.targetOpenId) as Row[]).map(toQuestion)
  }

  acceptReply(questionId: number, input: { messageId: string; senderOpenId: string; taskId: number }): BugQuestionReply {
    return this.transaction(() => {
      const question = this.requireQuestion(questionId)
      if (question.resolution === 'cancelled' || this.bugs.get(question.bucketId)?.intakePhase === 'cancelled') throw new Error('补问已取消，迟到答复不能自动恢复执行')
      if (input.taskId <= question.originTaskId) throw new Error('答复必须来自提问后的真实入站任务')
      const anchor = this.bugs.anchors(question.bucketId, question.spaceId).find((a) => a.id === question.anchorId)!
      if (input.senderOpenId !== question.targetOpenId) throw new Error('不能把其他成员的消息作为被询问人的答复')
      this.requireInbound(input.taskId, question.sessionKey, input.senderOpenId, input.messageId, anchor.chatId)
      if (!this.hasDeliveries() || !this.db.prepare("SELECT 1 FROM deliveries WHERE delivery_key = ? AND status IN ('sent','confirmed') AND remote_id IS NOT NULL AND remote_id != ''").get(question.deliveryKey)) throw new Error('问题尚无真实发送回执，不能猜测关联答复')
      const prior = this.db.prepare('SELECT * FROM bug_question_replies WHERE message_id = ? OR task_id = ?').all(input.messageId, input.taskId) as Row[]
      if (prior.length) {
        const row = prior[0]!
        if (prior.length !== 1 || Number(row.question_id) !== question.id || row.message_id !== input.messageId || row.sender_open_id !== input.senderOpenId || Number(row.task_id) !== input.taskId) throw new Error('这条真实答复已经绑定其他问题或任务')
        return toReply(row)
      }
      const result = this.db.prepare(`INSERT INTO bug_question_replies (question_id, message_id, sender_open_id, task_id, outcome, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`).run(questionId, input.messageId, input.senderOpenId, input.taskId, Date.now())
      return this.reply(Number(result.lastInsertRowid))!
    })
  }

  replies(questionId: number): BugQuestionReply[] {
    return (this.db.prepare('SELECT * FROM bug_question_replies WHERE question_id = ? ORDER BY id').all(questionId) as Row[]).map(toReply)
  }

  forTask(taskId: number): { question: BugQuestion; reply: BugQuestionReply }[] {
    return (this.db.prepare('SELECT * FROM bug_question_replies WHERE task_id = ? ORDER BY id').all(taskId) as Row[])
      .map((row) => ({ question: this.requireQuestion(Number(row.question_id)), reply: toReply(row) }))
  }

  resolveReply(questionId: number, replyId: number, taskId: number, outcome: Exclude<BugQuestionReplyOutcome, 'pending'>): BugQuestionReply {
    if (!['answered', 'declined', 'unavailable'].includes(outcome)) throw new Error('无效的答复处理结果')
    return this.transaction(() => {
      const question = this.requireQuestion(questionId)
      const reply = this.reply(replyId)
      if (!reply || reply.questionId !== questionId || reply.taskId !== taskId) throw new Error('只能处理当前任务绑定的真实答复')
      if (question.resolution === 'cancelled' || this.bugs.get(question.bucketId)?.intakePhase === 'cancelled') throw new Error('补问已取消，处理答复不能恢复它')
      const anchor = this.bugs.anchors(question.bucketId, question.spaceId).find((a) => a.id === question.anchorId)!
      const task = this.requireInbound(taskId, question.sessionKey, reply.senderOpenId, reply.messageId, anchor.chatId)
      if (task.status !== 'running' || task.stop_reason != null) throw new Error('答复任务已结束或停止，不能沿用旧任务处理结果')
      if (reply.outcome !== 'pending') {
        if (reply.outcome !== outcome) throw new Error('这条答复已经处理，不能改写之前的结果')
        return reply
      }
      this.db.prepare('UPDATE bug_question_replies SET outcome = ?, resolved_at = ? WHERE id = ?').run(outcome, Date.now(), replyId)
      this.db.prepare('UPDATE bug_questions SET resolution = ? WHERE id = ?').run(outcome === 'declined' ? 'declined' : 'answered', questionId)
      // 同一事务记入案件；other 与未标明类别的问题只保留答复结果，不记为已拒绝材料。
      if (outcome !== 'answered' && question.infoKind && question.infoKind !== 'other') {
        this.bugs.addDeclinedInfo({ bucketId: question.bucketId, spaceId: question.spaceId, kinds: [question.infoKind], source: 'reply',
          questionId: question.id, outcome, messageId: reply.messageId })
      }
      return this.reply(replyId)!
    })
  }

  private hasDeliveries(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get())
  }

  private requireBucket(id: number, spaceId: string): void {
    const bucket = this.bugs.get(id)
    if (!spaceId || !bucket || bucket.spaceId !== spaceId) throw new Error('没有这条反馈，或它不属于当前空间')
  }

  private requireQuestion(id: number): BugQuestion {
    const question = this.get(id)
    if (!question) throw new Error('没有这条补问')
    this.requireBucket(question.bucketId, question.spaceId)
    return question
  }

  private requireInbound(taskId: number, sessionKey: string, senderOpenId: string, messageId: string, chatId: string): Row {
    const row = this.db.prepare(`SELECT t.* FROM tasks t JOIN sessions s ON s.session_key = t.session_key
      JOIN task_receipts r ON r.task_id = t.id AND r.dedup_key = t.message_id
      WHERE t.id = ? AND t.session_key = ? AND t.requester_open_id = ? AND t.message_id = ? AND s.chat_id = ?`)
      .get(taskId, sessionKey, senderOpenId, messageId, chatId) as Row | undefined
    if (!row || !senderOpenId || !messageId) throw new Error('补问和答复必须绑定同一会话、本人的真实入站任务')
    return row
  }

  private reply(id: number): BugQuestionReply | undefined {
    const row = this.db.prepare('SELECT * FROM bug_question_replies WHERE id = ?').get(id) as Row | undefined
    return row ? toReply(row) : undefined
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT bug_question_write')
    try {
      const result = operation()
      this.db.exec('RELEASE SAVEPOINT bug_question_write')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK TO SAVEPOINT bug_question_write')
      this.db.exec('RELEASE SAVEPOINT bug_question_write')
      throw err
    }
  }
}

type Row = Record<string, unknown>
function toQuestion(row: Row): BugQuestion {
  return {
    id: Number(row.id), bucketId: Number(row.bucket_id), spaceId: String(row.space_id), sessionKey: String(row.session_key),
    originTaskId: Number(row.origin_task_id), targetOpenId: String(row.target_open_id), anchorId: Number(row.anchor_id),
    kind: 'info', question: String(row.question), missingInfo: JSON.parse(String(row.missing_info)) as string[],
    infoKind: (row.info_kind as BugInfoKind | null | undefined) ?? null, deliveryKey: `question:${row.id}`, resolution: row.resolution as BugQuestionResolution, createdAt: Number(row.created_at),
  }
}
function toReply(row: Row): BugQuestionReply {
  return {
    id: Number(row.id), questionId: Number(row.question_id), messageId: String(row.message_id), senderOpenId: String(row.sender_open_id),
    taskId: Number(row.task_id), outcome: row.outcome as BugQuestionReplyOutcome, createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
  }
}
function normalizeInput(input: BugQuestionInput): Required<Omit<BugQuestionInput, 'infoKind'>> & Pick<BugQuestionInput, 'infoKind'> {
  for (const id of [input.bucketId, input.originTaskId]) if (!Number.isSafeInteger(id) || id <= 0) throw new Error('反馈和任务 ID 无效')
  if (input.infoKind !== undefined && !isBugInfoKind(input.infoKind)) throw new Error('info_kind 不是支持的材料类别')
  const text = (value: string, label: string, max = 300): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}缺失或过长`)
    return value.trim()
  }
  const missingInfo = [...new Set((input.missingInfo ?? []).map((value) => text(value, '缺失项')))]
  if (missingInfo.length > 20) throw new Error('缺失信息最多 20 项')
  return {
    bucketId: input.bucketId, spaceId: text(input.spaceId, '空间'), sessionKey: text(input.sessionKey, '会话', 1000),
    originTaskId: input.originTaskId, targetOpenId: text(input.targetOpenId, '被询问人'), kind: 'info',
    question: text(input.question, '问题', 2000), missingInfo,
    anchor: {
      tenantId: text(input.anchor.tenantId, '租户'), appId: text(input.anchor.appId, '应用'),
      chatId: text(input.anchor.chatId, '聊天'), messageId: text(input.anchor.messageId, '消息'),
      ...(input.anchor.threadId === undefined ? {} : { threadId: text(input.anchor.threadId, '话题') }),
      ...(input.anchor.rootId === undefined ? {} : { rootId: text(input.anchor.rootId, '根消息') }),
      ...(input.anchor.parentId === undefined ? {} : { parentId: text(input.anchor.parentId, '父消息') }),
    },
    // 只在给出时加入，未标明类别的输入签名与旧版相同。
    ...(input.infoKind === undefined ? {} : { infoKind: input.infoKind }),
  }
}
