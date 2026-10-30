/**
 * Bug 收敛：把零散的吐槽归并成「桶」。
 *
 * 用户群里的反馈是一条条随口说的——「预览好像歪了」「这个页面是斜的」
 * 说的是同一件事。一条条记等于没记：没人知道这件事被提过几次、有没有在修。
 * 桶解决的是这个：**同一件事只有一个编号**，反馈挂在桶下面，桶有状态和计数。
 * 公司要做 PMO，要的就是这张表——「这周新开了几个桶、哪个桶被提得最多、多少还没人管」。
 *
 * 归并用 FTS5 trigram 做标题近似匹配，**只提候选、由模型确认**：
 * 自动合并两个其实不同的 bug，比多开一个桶糟得多——后者只是重复，前者会丢掉一个问题。
 */
import type { DatabaseSync } from 'node:sqlite'

export type BugStatus = 'open' | 'triaging' | 'fixed' | 'wontfix'
/** 只表示本地接单/诊断进度；linked_issue 之后的正式状态须读取 GitHub。 */
export type BugIntakePhase = 'new' | 'awaiting_info' | 'ready' | 'diagnosing' | 'triaged' | 'linked_issue' | 'resolved_without_issue' | 'cancelled'
/** 补问所要材料的类别，由调用方明确给出；other 表示不属于前四类，宿主不判断两条 other 是否同一材料。 */
export const BUG_INFO_KINDS = ['session_log', 'screenshot', 'repro_steps', 'version', 'other'] as const
export type BugInfoKind = typeof BUG_INFO_KINDS[number]
/** 可以记为“用户已表示不提供”的类别；宿主据此拒绝同类补问。 */
export const DECLINABLE_INFO_KINDS = ['session_log', 'screenshot', 'repro_steps', 'version'] as const
export type BugDeclinableInfoKind = typeof DECLINABLE_INFO_KINDS[number]
export const INFO_KIND_LABELS: Record<BugInfoKind, string> = { session_log: '会话日志', screenshot: '截图', repro_steps: '复现步骤', version: '版本信息', other: '其他材料' }

/** 案件级记录：用户已表示不提供或拿不到的材料。只追加；不授予读取权限，也不拒收用户之后主动提供的材料。 */
export interface BugDeclinedInfo {
  kind: BugDeclinableInfoKind
  /** statement：登记或更新阶段时由模型按用户原话传入；reply：补问答复被处理为 declined/unavailable。宿主不从文字推断。 */
  source: 'statement' | 'reply'
  /** reply 来源的补问编号。 */
  questionId?: number
  outcome?: 'declined' | 'unavailable'
  /** statement：登记时对应的反馈消息；reply：答复消息。 */
  messageId?: string
  at: number
}

export interface BugMessageAnchor {
  id: number
  bucketId: number
  tenantId: string
  appId: string
  chatId: string
  messageId: string
  threadId: string | null
  rootId: string | null
  parentId: string | null
  createdAt: number
}

/** 仅存引用，不下载材料，也不把引用、Session ID 或 receipt 当作读取授权。 */
export interface BugEvidenceRef {
  id: number
  bucketId: number
  kind: 'message' | 'code' | 'feedback_receipt' | 'user_export'
  sourceRef: string
  digest: string | null
  coverage: { state: 'unknown' | 'partial' | 'complete'; note?: string }
  /** 当前只允许留在本案。公开、跨群和分析原始材料都需另行授权。 */
  accessScope: 'case'
  expiresAt: number | null
  createdAt: number
}

export interface BugBucket {
  id: number
  spaceId: string | null
  title: string
  status: BugStatus
  intakePhase: BugIntakePhase
  missingInfo: string[]
  intakeUpdatedAt: number
  /** 收到过几条反馈 */
  count: number
  /** 旧版补问预占数；实际问题和发送回执由 BugQuestions 保存。 */
  asks: number
  /** 用户已表示不提供的材料；同类补问由 BugQuestions.prepare 拒绝。 */
  declinedInfo: BugDeclinedInfo[]
  note: string | null
  /** 升级成 GitHub issue 之后的链接。桶是内部账本，issue 才是对外的出口 */
  issueUrl: string | null
  firstSeenAt: number
  lastSeenAt: number
}

export interface BugReport {
  id: number
  bucketId: number
  chatId: string
  messageId: string | null
  reporterOpenId: string | null
  reporterName: string | null
  text: string
  /** user_note 是宿主捕获的用户补充，不是新的报障或执行委托。 */
  recordKind: 'report' | 'user_note'
  /** 相关产物的来源链接，用于直接核对报告内容 */
  link: string | null
  createdAt: number
}

/** 每案补问预算；未知发送仍占额，不能通过重试增加实际通知次数。 */
export const MAX_FOLLOWUP_ASKS = 3

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bug_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  count INTEGER NOT NULL DEFAULT 0,
  asks INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  issue_url TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bug_space ON bug_buckets(space_id, status, last_seen_at);
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  reporter_open_id TEXT,
  reporter_name TEXT,
  text TEXT NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'report' CHECK(record_kind IN ('report', 'user_note')),
  link TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bug_reports ON bug_reports(bucket_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bug_reports_msg ON bug_reports(message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS bug_message_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  root_id TEXT,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(bucket_id, tenant_id, app_id, chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_bug_anchor_message ON bug_message_anchors(tenant_id, app_id, chat_id, message_id);
CREATE INDEX IF NOT EXISTS idx_bug_anchor_thread ON bug_message_anchors(tenant_id, app_id, chat_id, thread_id);
CREATE TABLE IF NOT EXISTS bug_evidence_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  digest TEXT,
  coverage TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(bucket_id, kind, source_ref)
);
CREATE VIRTUAL TABLE IF NOT EXISTS bug_fts USING fts5(title, content='bug_buckets', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS bug_ai AFTER INSERT ON bug_buckets BEGIN
  INSERT INTO bug_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER IF NOT EXISTS bug_ad AFTER DELETE ON bug_buckets BEGIN
  INSERT INTO bug_fts(bug_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER IF NOT EXISTS bug_au AFTER UPDATE OF title ON bug_buckets BEGIN
  INSERT INTO bug_fts(bug_fts, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO bug_fts(rowid, title) VALUES (new.id, new.title);
END;
`

export class Bugs {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    // 存量库里没有 issue_url：CREATE TABLE IF NOT EXISTS 不会补列，得自己加
    const cols = new Set((db.prepare('PRAGMA table_info(bug_buckets)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('issue_url')) db.exec('ALTER TABLE bug_buckets ADD COLUMN issue_url TEXT')
    if (!cols.has('intake_phase')) {
      db.exec("ALTER TABLE bug_buckets ADD COLUMN intake_phase TEXT NOT NULL DEFAULT 'new'")
      db.exec(`UPDATE bug_buckets SET intake_phase = CASE
        WHEN issue_url IS NOT NULL THEN 'linked_issue'
        WHEN status = 'fixed' THEN 'resolved_without_issue'
        WHEN status = 'wontfix' THEN 'cancelled'
        WHEN status = 'triaging' THEN 'diagnosing' ELSE 'new' END`)
    }
    if (!cols.has('missing_info')) db.exec("ALTER TABLE bug_buckets ADD COLUMN missing_info TEXT NOT NULL DEFAULT '[]'")
    if (!cols.has('intake_updated_at')) {
      db.exec('ALTER TABLE bug_buckets ADD COLUMN intake_updated_at INTEGER NOT NULL DEFAULT 0')
      db.exec('UPDATE bug_buckets SET intake_updated_at = last_seen_at')
    }
    // 旧案件没有这项记录：默认空列表，不从历史答复或原话回填。
    if (!cols.has('declined_info')) db.exec("ALTER TABLE bug_buckets ADD COLUMN declined_info TEXT NOT NULL DEFAULT '[]'")
    const reportCols = new Set((db.prepare('PRAGMA table_info(bug_reports)').all() as { name: string }[]).map(c => c.name))
    if (!reportCols.has('record_kind')) db.exec("ALTER TABLE bug_reports ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'report' CHECK(record_kind IN ('report', 'user_note'))")
  }

  /** 标题相近的已有桶（给模型挑，不自动合）。 */
  similar(spaceId: string | null, title: string, limit = 5): BugBucket[] {
    const q = title.trim()
    if (!q) return []
    const terms = q.split(/\s+/).filter((t) => t.length >= 3)
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      try {
        const rows = this.db
          .prepare(
            `SELECT b.* FROM bug_fts f JOIN bug_buckets b ON b.id = f.rowid
             WHERE bug_fts MATCH ? AND b.space_id IS ? AND b.status IN ('open','triaging')
             ORDER BY bm25(bug_fts) LIMIT ?`,
          )
          .all(match, spaceId, limit) as Record<string, unknown>[]
        if (rows.length) return rows.map(toBucket)
      } catch {
        /* 语法错误就退化 */
      }
    }
    const like = `%${q.replace(/[%_]/g, '')}%`
    const rows = this.db
      .prepare(`SELECT * FROM bug_buckets WHERE space_id IS ? AND status IN ('open','triaging') AND title LIKE ? ORDER BY last_seen_at DESC LIMIT ?`)
      .all(spaceId, like, limit) as Record<string, unknown>[]
    return rows.map(toBucket)
  }

  /**
   * 记一条反馈。`bucketId` 给了就挂到那个桶（模型确认过是同一件事），
   * 否则开新桶。同一条飞书消息只算一次——主动巡检和 @ 触发可能都看到它。
   */
  record(input: {
    spaceId: string | null
    title: string
    chatId: string
    text: string
    bucketId?: number
    messageId?: string
    reporterOpenId?: string
    reporterName?: string
    link?: string
    now?: number
  }): { bucket: BugBucket; isNew: boolean; duplicate: boolean } {
    const now = input.now ?? Date.now()
    if (input.messageId) {
      const seen = this.db.prepare('SELECT bucket_id, chat_id FROM bug_reports WHERE message_id = ?').get(input.messageId) as { bucket_id: number; chat_id: string } | undefined
      if (seen) {
        const bucket = this.requireBucket(Number(seen.bucket_id), input.spaceId)
        if (seen.chat_id !== input.chatId || (input.bucketId !== undefined && input.bucketId !== bucket.id)) throw new Error('这条消息已关联其他反馈，不能改写归属')
        return { bucket, isNew: false, duplicate: true }
      }
    }
    let bucket = input.bucketId === undefined ? undefined : this.requireBucket(input.bucketId, input.spaceId)
    if (bucket?.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动追加报告')
    const isNew = !bucket
    if (!bucket) {
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || '（没写标题）'
      const res = this.db
        .prepare('INSERT INTO bug_buckets (space_id, title, status, count, asks, first_seen_at, last_seen_at, intake_updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)')
        .run(input.spaceId, title, 'open', now, now, now)
      bucket = this.get(Number(res.lastInsertRowid)) as BugBucket
    }
    this.db
      .prepare('INSERT INTO bug_reports (bucket_id, chat_id, message_id, reporter_open_id, reporter_name, text, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(bucket.id, input.chatId, input.messageId ?? null, input.reporterOpenId ?? null, input.reporterName ?? null, input.text.trim().slice(0, 2000), input.link ?? null, now)
    this.db.prepare('UPDATE bug_buckets SET count = count + 1, last_seen_at = ? WHERE id = ?').run(now, bucket.id)
    return { bucket: this.get(bucket.id) as BugBucket, isNew, duplicate: false }
  }

  get(id: number): BugBucket | undefined {
    const r = this.db.prepare('SELECT * FROM bug_buckets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toBucket(r) : undefined
  }

  /** 仅供可信入站宿主保存用户原文；调用方负责当前身份和消息来源核验。不会恢复执行或改变案件字段。 */
  captureUserNote(input: { bucketId: number; spaceId: string | null; chatId: string; messageId: string; reporterOpenId: string; reporterName?: string; text: string; now?: number }): { bucket: BugBucket; isNew: false; duplicate: boolean } {
    const bucket = this.requireBucket(input.bucketId, input.spaceId)
    if (bucket.intakePhase !== 'cancelled') throw new Error('用户补充入口仅用于已停止跟进的反馈')
    const chatId = requiredText(input.chatId, '会话 ID', 300)
    const messageId = requiredText(input.messageId, '消息 ID', 300)
    const reporterOpenId = requiredText(input.reporterOpenId, '发言人 ID', 300)
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('用户原文不能为空')
    const seen = this.db.prepare('SELECT * FROM bug_reports WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined
    if (seen) {
      if (Number(seen.bucket_id) !== bucket.id || seen.chat_id !== chatId) throw new Error('这条消息已关联其他反馈，不能改写归属')
      if (seen.record_kind !== 'user_note' || seen.reporter_open_id !== reporterOpenId || seen.text !== input.text) throw new Error('这条消息已经记录，不能改变记录类型、原文或发言人')
      return { bucket, isNew: false, duplicate: true }
    }
    this.db.prepare(`INSERT INTO bug_reports (bucket_id, chat_id, message_id, reporter_open_id, reporter_name, text, record_kind, link, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'user_note', NULL, ?)`)
      .run(bucket.id, chatId, messageId, reporterOpenId, input.reporterName ?? null, input.text, input.now ?? Date.now())
    return { bucket, isNew: false, duplicate: false }
  }

  reports(bucketId: number, limit = 50): BugReport[] {
    const rows = this.db.prepare('SELECT * FROM bug_reports WHERE bucket_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(bucketId, limit) as Record<string, unknown>[]
    return rows.map(toReport)
  }

  list(spaceId: string | null, opts: { status?: BugStatus; limit?: number } = {}): BugBucket[] {
    const limit = opts.limit ?? 30
    const rows = opts.status
      ? (this.db.prepare('SELECT * FROM bug_buckets WHERE space_id IS ? AND status = ? ORDER BY count DESC, last_seen_at DESC LIMIT ?').all(spaceId, opts.status, limit) as Record<string, unknown>[])
      : (this.db.prepare(`SELECT * FROM bug_buckets WHERE space_id IS ? AND status IN ('open','triaging') ORDER BY count DESC, last_seen_at DESC LIMIT ?`).all(spaceId, limit) as Record<string, unknown>[])
    return rows.map(toBucket)
  }

  setStatus(id: number, status: BugStatus, note?: string): BugBucket | undefined {
    const bucket = this.get(id)
    if (!bucket) return undefined
    if (bucket.issueUrl) throw new Error('已关联 GitHub Issue；请从 GitHub 读取或更新正式状态')
    if (bucket.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动恢复或改写状态')
    const phases: Record<BugStatus, BugIntakePhase> = { open: 'new', triaging: 'diagnosing', fixed: 'resolved_without_issue', wontfix: 'cancelled' }
    if (!Object.hasOwn(phases, status)) throw new Error('无效的反馈状态')
    if (status === 'wontfix') {
      this.db.prepare("UPDATE bug_buckets SET status = 'wontfix', note = COALESCE(?, note) WHERE id = ?").run(note ?? null, id)
      return this.get(id)
    }
    return this.setIntake({ bucketId: id, spaceId: bucket.spaceId, phase: phases[status], missingInfo: [], note })
  }

  /** spaceId 必须由调用方的可信会话注入；这些记录不授予任何原始材料读取权限。 */
  setIntake(input: { bucketId: number; spaceId: string | null; phase: BugIntakePhase; missingInfo?: string[]; note?: string; now?: number }): BugBucket {
    const bucket = this.requireBucket(input.bucketId, input.spaceId)
    const statusByPhase: Record<BugIntakePhase, BugStatus> = {
      new: 'open', awaiting_info: 'open', ready: 'triaging', diagnosing: 'triaging', triaged: 'triaging',
      linked_issue: 'triaging', resolved_without_issue: 'fixed', cancelled: 'wontfix',
    }
    if (!Object.hasOwn(statusByPhase, input.phase)) throw new Error('无效的接单阶段')
    if (input.phase === 'linked_issue' && !bucket.issueUrl) throw new Error('请先关联已创建的 GitHub Issue')
    if (bucket.issueUrl && input.phase !== 'linked_issue') throw new Error('已关联 GitHub Issue；不能用本地阶段覆盖正式状态')
    if (input.phase === 'cancelled') throw new Error('停止跟进须使用案件控制操作')
    if (bucket.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动恢复')
    const missing = input.missingInfo === undefined ? bucket.missingInfo : [...new Set(input.missingInfo.map((x) => requiredText(x, '缺失信息', 300)))]
    if (missing.length > 20) throw new Error('缺失信息最多 20 项')
    if (input.phase === 'awaiting_info' && !missing.length) throw new Error('等待信息时必须说明缺少什么')
    if (['ready', 'diagnosing', 'triaged'].includes(input.phase) && missing.length) throw new Error('仍有必要信息缺失，请先更新缺失项或保留等待状态')
    this.db.prepare('UPDATE bug_buckets SET intake_phase = ?, missing_info = ?, intake_updated_at = ?, status = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(input.phase, JSON.stringify(missing), input.now ?? Date.now(), bucket.issueUrl ? bucket.status : statusByPhase[input.phase], input.note ?? null, bucket.id)
    return this.get(bucket.id) as BugBucket
  }

  /** 仅供宿主停止事务使用；停止本地委托不改变问题是否已修复或拒修。 */
  stopFollowing(id: number, spaceId: string, now = Date.now()): BugBucket {
    this.requireBucket(id, spaceId)
    this.db.prepare("UPDATE bug_buckets SET intake_phase = 'cancelled', intake_updated_at = ? WHERE id = ? AND intake_phase != 'cancelled'").run(now, id)
    return this.get(id)!
  }

  /**
   * 记下用户已表示不提供的材料类别。只追加：同类已有记录时保留最早的来源。
   * 类别由调用方按用户原话或补问答复的处理结果给出，这里只校验取值，不从文字推断。
   */
  addDeclinedInfo(input: { bucketId: number; spaceId: string | null; kinds: readonly string[]; source: BugDeclinedInfo['source']
    questionId?: number; outcome?: BugDeclinedInfo['outcome']; messageId?: string; now?: number }): BugBucket {
    const kinds = declinedKinds(input.kinds)
    const bucket = this.requireBucket(input.bucketId, input.spaceId)
    if (bucket.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动追加材料限制')
    const known = new Set(bucket.declinedInfo.map((entry) => entry.kind))
    const at = input.now ?? Date.now()
    const added = kinds.filter((kind) => !known.has(kind)).map((kind): BugDeclinedInfo => ({
      kind, source: input.source,
      ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.messageId === undefined ? {} : { messageId: requiredText(input.messageId, '消息 ID', 300) }),
      at,
    }))
    if (!added.length) return bucket
    this.db.prepare('UPDATE bug_buckets SET declined_info = ? WHERE id = ?').run(JSON.stringify([...bucket.declinedInfo, ...added]), bucket.id)
    return this.get(bucket.id)!
  }

  addAnchor(input: Omit<BugMessageAnchor, 'id' | 'createdAt' | 'threadId' | 'rootId' | 'parentId'> & {
    spaceId: string | null; threadId?: string; rootId?: string; parentId?: string; now?: number
  }): BugMessageAnchor {
    if (this.requireBucket(input.bucketId, input.spaceId).intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动追加锚点')
    const ids = [input.tenantId, input.appId, input.chatId, input.messageId].map((x) => requiredText(x, '消息锚点 ID', 300))
    const optional = [input.threadId, input.rootId, input.parentId].map((x) => x === undefined ? null : requiredText(x, '消息关联 ID', 300))
    const existing = this.db.prepare('SELECT * FROM bug_message_anchors WHERE bucket_id = ? AND tenant_id = ? AND app_id = ? AND chat_id = ? AND message_id = ?')
      .get(input.bucketId, ...ids) as Record<string, unknown> | undefined
    if (existing) {
      for (const [index, key] of ['thread_id', 'root_id', 'parent_id'].entries()) {
        if (existing[key] !== null && optional[index] !== null && existing[key] !== optional[index]) throw new Error('消息锚点已有关联，不能改绑到其他讨论')
      }
      this.db.prepare('UPDATE bug_message_anchors SET thread_id = COALESCE(thread_id, ?), root_id = COALESCE(root_id, ?), parent_id = COALESCE(parent_id, ?) WHERE id = ?')
        .run(...optional, Number(existing.id))
      return toAnchor(this.db.prepare('SELECT * FROM bug_message_anchors WHERE id = ?').get(Number(existing.id)) as Record<string, unknown>)
    }
    const result = this.db.prepare('INSERT INTO bug_message_anchors (bucket_id, tenant_id, app_id, chat_id, message_id, thread_id, root_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.bucketId, ...ids, ...optional, input.now ?? Date.now())
    return toAnchor(this.db.prepare('SELECT * FROM bug_message_anchors WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, unknown>)
  }

  anchors(bucketId: number, spaceId: string | null): BugMessageAnchor[] {
    this.requireBucket(bucketId, spaceId)
    return (this.db.prepare('SELECT * FROM bug_message_anchors WHERE bucket_id = ? ORDER BY id').all(bucketId) as Record<string, unknown>[]).map(toAnchor)
  }

  /** 一条消息可作多案证据；返回全部候选，不能取第一条自动路由。 */
  findByAnchor(input: { spaceId: string | null; tenantId: string; appId: string; chatId: string; messageId?: string; threadId?: string }): BugBucket[] {
    if (Number(input.messageId !== undefined) + Number(input.threadId !== undefined) !== 1) throw new Error('必须精确指定 messageId 或 threadId 其中之一')
    const ids = [input.tenantId, input.appId, input.chatId, input.messageId ?? input.threadId].map((x) => requiredText(x, '消息锚点 ID', 300))
    const field = input.messageId === undefined ? 'thread_id' : 'message_id'
    return (this.db.prepare(`SELECT DISTINCT b.* FROM bug_buckets b JOIN bug_message_anchors a ON a.bucket_id = b.id
      WHERE b.space_id IS ? AND a.tenant_id = ? AND a.app_id = ? AND a.chat_id = ? AND a.${field} = ? ORDER BY b.id`)
      .all(input.spaceId, ...ids) as Record<string, unknown>[]).map(toBucket)
  }

  addEvidence(input: Omit<BugEvidenceRef, 'id' | 'createdAt' | 'digest' | 'expiresAt' | 'accessScope'> & {
    spaceId: string | null; digest?: string; expiresAt?: number; now?: number
  }): BugEvidenceRef {
    if (this.requireBucket(input.bucketId, input.spaceId).intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动追加证据')
    if (!['message', 'code', 'feedback_receipt', 'user_export'].includes(input.kind)) throw new Error('不支持的证据类型')
    const sourceRef = requiredText(input.sourceRef, '证据引用', 2000)
    if (input.digest !== undefined && !/^[a-f0-9]{64}$/i.test(input.digest)) throw new Error('digest 必须是 SHA-256')
    if (!input.coverage || !['unknown', 'partial', 'complete'].includes(input.coverage.state)) throw new Error('需要明确证据覆盖范围')
    if (input.kind === 'feedback_receipt' && input.coverage.state !== 'unknown') throw new Error('反馈回执不证明会话日志已接收或完整')
    const coverage = { state: input.coverage.state, ...(input.coverage.note === undefined ? {} : { note: requiredText(input.coverage.note, '覆盖说明', 1000) }) }
    const now = input.now ?? Date.now()
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) throw new Error('证据过期时间必须晚于接收时间')
    const digest = input.digest?.toLowerCase() ?? null
    const expiresAt = input.expiresAt ?? null
    const existing = this.db.prepare('SELECT * FROM bug_evidence_refs WHERE bucket_id = ? AND kind = ? AND source_ref = ?')
      .get(input.bucketId, input.kind, sourceRef) as Record<string, unknown> | undefined
    if (existing) {
      if (existing.digest !== digest || existing.coverage !== JSON.stringify(coverage) || existing.expires_at !== expiresAt) throw new Error('证据引用已记录；不能覆盖已有快照或延长授权期限')
      return toEvidence(existing)
    }
    const result = this.db.prepare('INSERT INTO bug_evidence_refs (bucket_id, kind, source_ref, digest, coverage, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.bucketId, input.kind, sourceRef, digest, JSON.stringify(coverage), expiresAt, now)
    return toEvidence(this.db.prepare('SELECT * FROM bug_evidence_refs WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, unknown>)
  }

  evidence(bucketId: number, spaceId: string | null, now = Date.now()): (BugEvidenceRef & { expired: boolean })[] {
    this.requireBucket(bucketId, spaceId)
    return (this.db.prepare('SELECT * FROM bug_evidence_refs WHERE bucket_id = ? ORDER BY id').all(bucketId) as Record<string, unknown>[]).map((row) => {
      const ref = toEvidence(row)
      return { ...ref, expired: ref.expiresAt !== null && ref.expiresAt <= now }
    })
  }

  private requireBucket(id: number, spaceId: string | null): BugBucket {
    const bucket = this.get(id)
    if (!bucket || bucket.spaceId !== spaceId) throw new Error('没有这条反馈，或它不属于当前空间')
    return bucket
  }

  /**
   * 关联到这个 Issue 的案件（跨空间；同一个 Issue 可能在几个群各有一个案件）。
   * 用 sameIssueReference 比：旧存量的尾斜杠、大小写都算同一个。已停止跟进的不算。
   */
  linkedToIssue(issueUrl: string): BugBucket[] {
    if (!parseIssueReference(issueUrl)) return []
    return (this.db.prepare("SELECT * FROM bug_buckets WHERE issue_url IS NOT NULL AND intake_phase <> 'cancelled' ORDER BY id").all() as Record<string, unknown>[])
      .map(toBucket).filter((b) => b.issueUrl !== null && sameIssueReference(b.issueUrl, issueUrl))
  }

  /** 关联已获准创建并核实存在的 Issue，正式研发状态继续由 GitHub 提供。 */
  linkIssue(id: number, issueUrl: string, note?: string): BugBucket | undefined {
    const bucket = this.get(id)
    if (!bucket) return undefined
    if (bucket.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动关联 Issue 或恢复')
    if (bucket.issueUrl && !sameIssueReference(bucket.issueUrl, issueUrl)) throw new Error('这条反馈已经关联其他 Issue，不能自动改绑')
    this.db
      .prepare(`UPDATE bug_buckets SET issue_url = ?, intake_phase = 'linked_issue', intake_updated_at = ?, status = CASE status WHEN 'open' THEN 'triaging' ELSE status END, note = COALESCE(?, note) WHERE id = ?`)
      .run(issueUrl, Date.now(), note ?? null, id)
    return this.get(id)
  }

  retitle(id: number, title: string): BugBucket | undefined {
    if (this.get(id)?.intakePhase === 'cancelled') throw new Error('本案已停止跟进，不能自动改写标题')
    this.db.prepare('UPDATE bug_buckets SET title = ? WHERE id = ?').run(title.replace(/\s+/g, ' ').trim().slice(0, 120), id)
    return this.get(id)
  }

  /**
   * 还能不能再追问一轮。能就顺手把计数加一——**先扣预算再问**，
   * 不然模型问完忘了记，上限就形同虚设。
   */
  tryAsk(id: number): { allowed: boolean; used: number; max: number } {
    const b = this.get(id)
    if (!b) return { allowed: false, used: 0, max: MAX_FOLLOWUP_ASKS }
    if (b.intakePhase === 'cancelled') return { allowed: false, used: b.asks, max: MAX_FOLLOWUP_ASKS }
    if (b.asks >= MAX_FOLLOWUP_ASKS) return { allowed: false, used: b.asks, max: MAX_FOLLOWUP_ASKS }
    this.db.prepare('UPDATE bug_buckets SET asks = asks + 1 WHERE id = ?').run(id)
    return { allowed: true, used: b.asks + 1, max: MAX_FOLLOWUP_ASKS }
  }

  /** PMO 要的那几个数。 */
  stats(spaceId: string | null, sinceMs: number): { open: number; newBuckets: number; reports: number; top: BugBucket[] } {
    const one = (sql: string, ...a: unknown[]) => Number((this.db.prepare(sql).get(...(a as never[])) as { c: number }).c)
    return {
      open: one(`SELECT COUNT(*) c FROM bug_buckets WHERE space_id IS ? AND status IN ('open','triaging')`, spaceId),
      newBuckets: one('SELECT COUNT(*) c FROM bug_buckets WHERE space_id IS ? AND first_seen_at >= ?', spaceId, sinceMs),
      reports: one("SELECT COUNT(*) c FROM bug_reports r JOIN bug_buckets b ON b.id = r.bucket_id WHERE b.space_id IS ? AND r.created_at >= ? AND r.record_kind = 'report'", spaceId, sinceMs),
      top: this.list(spaceId, { limit: 5 }),
    }
  }
}

/** 只解析 Issue 引用格式；真实性和访问权限仍须由网关向已配置的 GitHub API 核实。 */
export function parseIssueReference(value: unknown): { repo: string; number: number; url: string } | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || !match) return undefined
    const number = Number(match[3])
    if (!Number.isSafeInteger(number)) return undefined
    return { repo: `${match[1]}/${match[2]}`, number, url: `${url.origin}/${match[1]}/${match[2]}/issues/${number}` }
  } catch { return undefined }
}

/** 兼容旧存量的锚点、尾斜杠和仓库大小写；不同站点、仓库或编号仍是不同 Issue。 */
export function sameIssueReference(left: string, right: string): boolean {
  if (left === right) return true
  const a = parseIssueReference(left), b = parseIssueReference(right)
  return !!a && !!b && a.url.toLowerCase() === b.url.toLowerCase()
}

export function isBugInfoKind(value: unknown): value is BugInfoKind {
  return typeof value === 'string' && (BUG_INFO_KINDS as readonly string[]).includes(value)
}

/** 校验并去重；other 与任意文字都不能记为已拒绝材料。 */
export function declinedKinds(values: readonly unknown[]): BugDeclinableInfoKind[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !(DECLINABLE_INFO_KINDS as readonly string[]).includes(value))) {
    throw new Error(`已拒绝材料类型只能是 ${DECLINABLE_INFO_KINDS.join('、')}`)
  }
  return [...new Set(values as BugDeclinableInfoKind[])]
}

function toBucket(r: Record<string, unknown>): BugBucket {
  return {
    id: Number(r.id),
    spaceId: (r.space_id as string | null) ?? null,
    title: String(r.title),
    status: (r.status as BugStatus) ?? 'open',
    intakePhase: r.intake_phase as BugIntakePhase,
    missingInfo: JSON.parse(String(r.missing_info)) as string[],
    intakeUpdatedAt: Number(r.intake_updated_at),
    count: Number(r.count ?? 0),
    asks: Number(r.asks ?? 0),
    declinedInfo: JSON.parse(String(r.declined_info)) as BugDeclinedInfo[],
    note: (r.note as string | null) ?? null,
    issueUrl: (r.issue_url as string | null) ?? null,
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
  }
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须非空且不超过 ${max} 字符`)
  return value.trim()
}

function toAnchor(r: Record<string, unknown>): BugMessageAnchor {
  return { id: Number(r.id), bucketId: Number(r.bucket_id), tenantId: String(r.tenant_id), appId: String(r.app_id), chatId: String(r.chat_id), messageId: String(r.message_id),
    threadId: r.thread_id as string | null, rootId: r.root_id as string | null, parentId: r.parent_id as string | null, createdAt: Number(r.created_at) }
}

function toEvidence(r: Record<string, unknown>): BugEvidenceRef {
  return { id: Number(r.id), bucketId: Number(r.bucket_id), kind: r.kind as BugEvidenceRef['kind'], sourceRef: String(r.source_ref), digest: r.digest as string | null,
    coverage: JSON.parse(String(r.coverage)) as BugEvidenceRef['coverage'], accessScope: 'case', expiresAt: r.expires_at === null ? null : Number(r.expires_at), createdAt: Number(r.created_at) }
}

function toReport(r: Record<string, unknown>): BugReport {
  return {
    id: Number(r.id),
    bucketId: Number(r.bucket_id),
    chatId: String(r.chat_id),
    messageId: (r.message_id as string | null) ?? null,
    reporterOpenId: (r.reporter_open_id as string | null) ?? null,
    reporterName: (r.reporter_name as string | null) ?? null,
    text: String(r.text),
    recordKind: r.record_kind as BugReport['recordKind'],
    link: (r.link as string | null) ?? null,
    createdAt: Number(r.created_at),
  }
}
