/**
 * 私聊里我能读哪些会话：**默认全开，可以逐个排除**。
 *
 * 取舍是明确的：连接（/connect）之后立刻就能用——问"我上周在哪个群说过 xx"不需要先去勾一遍群，
 * 跨群搜索也是全量的。代价是连接那一下授权面确实大，所以卡片要把这件事说清楚，
 * 并且给一个**单独停掉某个群**的入口：停掉一个不影响其他，恢复后从上次读到的位置接着读。
 *
 * 所以这张表只存"排除"，不存"授权"：没有记录就是可读。
 * 这样默认行为不依赖任何一次枚举（连接时群列表读不全也不会误伤），也不会随时间漂移。
 */
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_read_exclusions (
  open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  excluded_at INTEGER NOT NULL,
  restored_at INTEGER,
  PRIMARY KEY (open_id, chat_id)
);
CREATE INDEX IF NOT EXISTS chat_read_exclusions_by_chat ON chat_read_exclusions (chat_id);
`

export interface ChatExclusion {
  openId: string
  chatId: string
  excludedAt: number
  restoredAt: number | null
  /** 当前是否还在排除中 */
  active: boolean
}

interface Row { open_id: string; chat_id: string; excluded_at: number; restored_at: number | null }

export class ChatReadScope {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA)
  }

  private shape(r: Row): ChatExclusion {
    return { openId: r.open_id, chatId: r.chat_id, excludedAt: r.excluded_at, restoredAt: r.restored_at, active: r.restored_at === null }
  }

  /** 默认可读；只有明确排除过、且没恢复的会话读不了。 */
  isReadable(openId: string, chatId: string): boolean {
    const row = this.db.prepare('SELECT * FROM chat_read_exclusions WHERE open_id = ? AND chat_id = ?').get(openId, chatId) as Row | undefined
    return !row || row.restored_at !== null
  }

  /** 停读某个会话。只停这一个，其他不受影响；游标不在这张表里，所以恢复后接着读。 */
  exclude(openId: string, chatId: string): ChatExclusion {
    this.db.prepare(
      `INSERT INTO chat_read_exclusions (open_id, chat_id, excluded_at, restored_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(open_id, chat_id) DO UPDATE SET excluded_at = excluded.excluded_at, restored_at = NULL`,
    ).run(openId, chatId, this.now())
    return this.get(openId, chatId)!
  }

  /** 恢复读取。保留这条记录，好回答"我什么时候停过、什么时候又开的"。 */
  restore(openId: string, chatId: string): boolean {
    const r = this.db.prepare(
      'UPDATE chat_read_exclusions SET restored_at = ? WHERE open_id = ? AND chat_id = ? AND restored_at IS NULL',
    ).run(this.now(), openId, chatId)
    return Number(r.changes) > 0
  }

  get(openId: string, chatId: string): ChatExclusion | undefined {
    const row = this.db.prepare('SELECT * FROM chat_read_exclusions WHERE open_id = ? AND chat_id = ?').get(openId, chatId) as Row | undefined
    return row ? this.shape(row) : undefined
  }

  /** 当前仍在排除中的会话。 */
  excludedChatIds(openId: string): string[] {
    return this.list(openId).filter((e) => e.active).map((e) => e.chatId)
  }

  /** 全部记录，含已恢复的——卡片要显示得出来。 */
  list(openId: string): ChatExclusion[] {
    const rows = this.db.prepare('SELECT * FROM chat_read_exclusions WHERE open_id = ? ORDER BY excluded_at DESC').all(openId) as unknown as Row[]
    return rows.map((r) => this.shape(r))
  }
}
