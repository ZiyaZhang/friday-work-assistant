/**
 * 群聊消息缓存：所有经 API 拉过、或经事件收到的消息都落进 SQLite + FTS5，
 * 让"找陆知行上周发的那个文件""总结 项目群最近一周"这类问题不必每次都重新翻 API，
 * 也绕开飞书历史接口单次拉取的上限。覆盖窗口表记录每个群已经拉过哪些时间段，
 * 搜索时只回填缺口。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryMessage } from '../feishu/client.js'
import { messagePosition, type MessageLinkSource } from '../feishu/message-links.js'

export interface CachedMessage extends HistoryMessage {
  chatId: string
}

export interface SearchQuery {
  chatIds: string[]
  query?: string
  sender?: string
  startMs?: number
  endMs?: number
  msgType?: string
  limit?: number
}

export interface Window {
  startSec: number
  endSec: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  create_time INTEGER NOT NULL,
  msg_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_open_id TEXT,
  sender_type TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_id TEXT,
  root_id TEXT,
  parent_id TEXT,
  file_key TEXT,
  file_name TEXT,
  image_key TEXT,
  cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, create_time);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(chat_id, sender_name);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, sender_name, file_name, content='messages', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, sender_name, file_name) VALUES (new.rowid, new.text, new.sender_name, coalesce(new.file_name, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_name, file_name) VALUES ('delete', old.rowid, old.text, old.sender_name, coalesce(old.file_name, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_name, file_name) VALUES ('delete', old.rowid, old.text, old.sender_name, coalesce(old.file_name, ''));
  INSERT INTO messages_fts(rowid, text, sender_name, file_name) VALUES (new.rowid, new.text, new.sender_name, coalesce(new.file_name, ''));
END;
CREATE TABLE IF NOT EXISTS chat_coverage (
  chat_id TEXT NOT NULL,
  start_sec INTEGER NOT NULL,
  end_sec INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverage_chat ON chat_coverage(chat_id, start_sec);
`

export class MessageCache {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    // Additive migration: old message bodies and coverage windows remain intact.
    const columns = new Set((db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(row => row.name))
    for (const column of ['message_app_link', 'message_position', 'thread_message_position']) {
      if (!columns.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`)
    }
  }

  upsert(chatId: string, messages: HistoryMessage[]): number {
    if (!messages.length) return 0
    const stmt = this.db.prepare(
      `INSERT INTO messages (message_id, chat_id, create_time, msg_type, sender_name, sender_open_id, sender_type, text, thread_id, root_id, parent_id, file_key, file_name, image_key, cached_at, message_app_link, message_position, thread_message_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         text = CASE
           WHEN excluded.msg_type = 'interactive'
             AND (trim(excluded.text) IN ('', '[卡片]') OR instr(excluded.text, '[卡片正文未取得') > 0)
             AND trim(messages.text) NOT IN ('', '[卡片]') AND instr(messages.text, '[卡片正文未取得') = 0
           THEN messages.text ELSE excluded.text END,
         sender_name = CASE WHEN excluded.sender_name != '' THEN excluded.sender_name ELSE messages.sender_name END,
         thread_id = coalesce(excluded.thread_id, messages.thread_id), root_id = coalesce(excluded.root_id, messages.root_id),
         parent_id = coalesce(excluded.parent_id, messages.parent_id), file_key = coalesce(excluded.file_key, messages.file_key),
         file_name = coalesce(excluded.file_name, messages.file_name), image_key = coalesce(excluded.image_key, messages.image_key), cached_at = excluded.cached_at,
         message_app_link = coalesce(excluded.message_app_link, messages.message_app_link),
         message_position = coalesce(excluded.message_position, messages.message_position),
         thread_message_position = coalesce(excluded.thread_message_position, messages.thread_message_position)
       WHERE messages.chat_id = excluded.chat_id`,
    )
    const now = Date.now()
    let n = 0
    for (const m of messages) {
      if (!m.messageId || (m.chatId && m.chatId !== chatId)) continue
      const result = stmt.run(
        m.messageId,
        chatId,
        m.createTimeMs,
        m.msgType,
        m.senderName,
        m.senderOpenId ?? null,
        m.senderType,
        m.text,
        m.threadId ?? null,
        m.rootId ?? null,
        m.parentId ?? null,
        m.fileKey ?? null,
        m.fileName ?? null,
        m.imageKey ?? null,
        now,
        m.messageAppLink?.trim() || null,
        messagePosition(m.messagePosition) ?? null,
        messagePosition(m.threadMessagePosition) ?? null,
      )
      n += Number(result.changes)
    }
    return n
  }

  /** A link lookup enriches only platform location evidence, never cached body/identity. */
  rememberLocation(messageId: string, chatId: string, source: MessageLinkSource): boolean {
    if (!source.chatId || source.chatId !== chatId) return false
    return Number(this.db.prepare(`UPDATE messages SET
      message_app_link=coalesce(?,message_app_link), message_position=coalesce(?,message_position),
      thread_message_position=coalesce(?,thread_message_position), thread_id=coalesce(?,thread_id)
      WHERE message_id=? AND chat_id=?`).run(source.messageAppLink?.trim() || null,
      messagePosition(source.messagePosition) ?? null, messagePosition(source.threadMessagePosition) ?? null,
      source.threadId ?? null, messageId, chatId).changes) > 0
  }

  /** 撤回：把这条从缓存里抹掉。撤回在飞书是有明确语义的动作，留着等于当没发生过。 */
  remove(messageId: string): boolean {
    return Number(this.db.prepare('DELETE FROM messages WHERE message_id = ?').run(messageId).changes) > 0
  }

  get(messageId: string): CachedMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined
    return r ? toCached(r) : undefined
  }

  /**
   * 同一话题里 sinceMs 之后的消息，按时间正序，最多 500 条。同一话题以根消息为准：根消息上记下的待办当时还没有 thread_id，
   * 话题里的消息都带 root_id = 根消息，所以按根消息或已知的 thread_id 任一匹配。缓存里没有的消息不在结果里。
   */
  thread(anchor: { chatId: string; threadId?: string; rootMessageId: string }, sinceMs: number): CachedMessage[] {
    const threadId = anchor.threadId ?? null
    const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND create_time > ?
      AND (root_id = ? OR (? IS NOT NULL AND thread_id = ?)) ORDER BY create_time LIMIT 500`)
      .all(anchor.chatId, sinceMs, anchor.rootMessageId, threadId, threadId) as Record<string, unknown>[]
    return rows.map(toCached)
  }

  count(chatId?: string): number {
    const r = (chatId
      ? this.db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(chatId)
      : this.db.prepare('SELECT COUNT(*) c FROM messages').get()) as { c: number }
    return Number(r.c)
  }

  /** 关键词走 FTS（≥3 字）或 LIKE；发言人、类型、时间范围做普通过滤；按时间正序返回。 */
  search(q: SearchQuery): CachedMessage[] {
    if (!q.chatIds.length) return []
    // history 对外最多 500 条；内部多取一条用于判断这一页是否真的结束。
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 501)
    const where: string[] = [`m.chat_id IN (${q.chatIds.map(() => '?').join(',')})`]
    const args: unknown[] = [...q.chatIds]
    if (q.startMs !== undefined) {
      where.push('m.create_time >= ?')
      args.push(q.startMs)
    }
    if (q.endMs !== undefined) {
      where.push('m.create_time < ?')
      args.push(q.endMs)
    }
    if (q.sender) {
      where.push('(m.sender_name LIKE ? OR m.sender_open_id = ?)')
      args.push(`%${q.sender.replace(/[%_]/g, '')}%`, q.sender)
    }
    if (q.msgType) {
      where.push('m.msg_type = ?')
      args.push(q.msgType)
    }
    const query = q.query?.trim() ?? ''
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean)
      const ftsTerms = terms.filter((t) => t.length >= 3)
      if (ftsTerms.length === terms.length) {
        const match = ftsTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
        try {
          const rows = this.db
            .prepare(
              `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
               WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.create_time ASC LIMIT ?`,
            )
            .all(match, ...(args as never[]), limit) as Record<string, unknown>[]
          return rows.map(toCached)
        } catch {
          /* 语法问题退化为 LIKE */
        }
      }
      for (const t of terms) {
        where.push('(m.text LIKE ? OR m.sender_name LIKE ? OR coalesce(m.file_name, \'\') LIKE ?)')
        const like = `%${t.replace(/[%_]/g, '')}%`
        args.push(like, like, like)
      }
    }
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.create_time ASC LIMIT ?`)
      .all(...(args as never[]), limit) as Record<string, unknown>[]
    return rows.map(toCached)
  }

  /** 该群里带附件的消息（找"某人发的那个文件"用）。 */
  files(chatIds: string[], opts: { sender?: string; nameLike?: string; limit?: number; startMs?: number; endMs?: number } = {}): CachedMessage[] {
    if (!chatIds.length) return []
    const where = [`chat_id IN (${chatIds.map(() => '?').join(',')})`, `(file_key IS NOT NULL OR image_key IS NOT NULL)`]
    const args: unknown[] = [...chatIds]
    if (opts.startMs !== undefined) {
      where.push('create_time >= ?')
      args.push(opts.startMs)
    }
    if (opts.endMs !== undefined) {
      where.push('create_time < ?')
      args.push(opts.endMs)
    }
    if (opts.sender) {
      where.push('sender_name LIKE ?')
      args.push(`%${opts.sender}%`)
    }
    if (opts.nameLike) {
      where.push("coalesce(file_name, '') LIKE ?")
      args.push(`%${opts.nameLike}%`)
    }
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY create_time DESC LIMIT ?`)
      .all(...(args as never[]), Math.min(opts.limit ?? 50, 200)) as Record<string, unknown>[]
    return rows.map(toCached)
  }

  // ---- 覆盖窗口 ----

  markCovered(chatId: string, startSec: number, endSec: number): void {
    if (endSec <= startSec) return
    const merged = mergeWindows([...this.coverage(chatId), { startSec, endSec }])
    this.db.prepare('DELETE FROM chat_coverage WHERE chat_id = ?').run(chatId)
    const ins = this.db.prepare('INSERT INTO chat_coverage (chat_id, start_sec, end_sec) VALUES (?, ?, ?)')
    for (const w of merged) ins.run(chatId, w.startSec, w.endSec)
  }

  coverage(chatId: string): Window[] {
    const rows = this.db.prepare('SELECT start_sec, end_sec FROM chat_coverage WHERE chat_id = ? ORDER BY start_sec').all(chatId) as { start_sec: number; end_sec: number }[]
    return rows.map((r) => ({ startSec: Number(r.start_sec), endSec: Number(r.end_sec) }))
  }

  /** [startSec, endSec) 里还没拉过的子区间。 */
  missingWindows(chatId: string, startSec: number, endSec: number): Window[] {
    const gaps: Window[] = []
    let cursor = startSec
    for (const w of this.coverage(chatId)) {
      if (w.endSec <= cursor) continue
      if (w.startSec >= endSec) break
      if (w.startSec > cursor) gaps.push({ startSec: cursor, endSec: Math.min(w.startSec, endSec) })
      cursor = Math.max(cursor, w.endSec)
      if (cursor >= endSec) break
    }
    if (cursor < endSec) gaps.push({ startSec: cursor, endSec })
    return gaps
  }
}

export function mergeWindows(ws: Window[]): Window[] {
  const sorted = [...ws].filter((w) => w.endSec > w.startSec).sort((a, b) => a.startSec - b.startSec)
  const out: Window[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.startSec <= last.endSec) last.endSec = Math.max(last.endSec, w.endSec)
    else out.push({ ...w })
  }
  return out
}

function toCached(r: Record<string, unknown>): CachedMessage {
  return {
    chatId: String(r.chat_id),
    messageId: String(r.message_id),
    createTimeMs: Number(r.create_time),
    msgType: String(r.msg_type),
    senderName: String(r.sender_name),
    senderOpenId: (r.sender_open_id as string | null) ?? undefined,
    senderType: String(r.sender_type),
    text: String(r.text),
    threadId: (r.thread_id as string | null) ?? undefined,
    rootId: (r.root_id as string | null) ?? undefined,
    parentId: (r.parent_id as string | null) ?? undefined,
    fileKey: (r.file_key as string | null) ?? undefined,
    fileName: (r.file_name as string | null) ?? undefined,
    imageKey: (r.image_key as string | null) ?? undefined,
    ...(r.message_app_link ? { messageAppLink: String(r.message_app_link) } : {}),
    ...(r.message_position ? { messagePosition: String(r.message_position) } : {}),
    ...(r.thread_message_position ? { threadMessagePosition: String(r.thread_message_position) } : {}),
  }
}
