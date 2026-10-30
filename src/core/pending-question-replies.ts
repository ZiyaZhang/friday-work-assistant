import type { DatabaseSync } from 'node:sqlite'
import type { InboundMessage } from '../feishu/mention.js'

/** 平台 ACK 晚于人的回复时，暂存真实入站；只按后续 remote ID 关联，不猜案件。 */
export class PendingQuestionReplies {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS pending_question_replies (
      message_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      target_open_id TEXT NOT NULL, inbound TEXT NOT NULL
    )`)
  }

  save(spaceId: string, msg: InboundMessage): void {
    if (!msg.parentId || !msg.senderOpenId || !msg.tenantId) throw new Error('待关联答复缺少真实消息身份')
    this.db.prepare(`INSERT OR IGNORE INTO pending_question_replies
      (message_id,space_id,chat_id,target_open_id,inbound) VALUES (?,?,?,?,?)`)
      .run(msg.messageId, spaceId, msg.chatId, msg.senderOpenId, JSON.stringify(msg))
  }

  list(spaceId: string, targetOpenId: string): InboundMessage[] {
    const rows = this.db.prepare('SELECT inbound FROM pending_question_replies WHERE space_id = ? AND target_open_id = ? ORDER BY rowid')
      .all(spaceId, targetOpenId) as { inbound: string }[]
    return rows.map((row) => JSON.parse(row.inbound) as InboundMessage)
  }

  has(messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM pending_question_replies WHERE message_id = ?').get(messageId))
  }

  remove(messageId: string): void {
    this.db.prepare('DELETE FROM pending_question_replies WHERE message_id = ?').run(messageId)
  }
}
