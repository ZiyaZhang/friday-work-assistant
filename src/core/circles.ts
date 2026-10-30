/**
 * Circle（联盟）：把几个空间结成一个联盟，联盟内跨群**可读**——在 A 群可以问"B 群昨天讨论了什么"。
 * Circle 关联多个空间；Space 表示单个群或个人的独立空间。
 *
 * 边界：联盟只影响"眼睛"，不影响"手和嘴"——Friday 永远只在自己所在的空间说话做事。
 * 默认没有联盟，群会话只读本群；哪些群该互通由空间负责人决定（`!circle join <名字>`），不由网关猜。
 */
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS circles (
  chat_id TEXT PRIMARY KEY,
  circle TEXT NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_circles_name ON circles(circle);
`

export const CIRCLE_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u

export interface CircleMembership {
  chatId: string
  circle: string
  addedBy: string | null
  addedAt: number
}

export class Circles {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    // 老库：原来的 spaces 表（chat_id, space, ...）搬成 circles，再让位给新的 Space 对象
    const legacy = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='spaces'`).get() as { name?: string } | undefined
    if (legacy?.name) {
      const cols = (db.prepare('PRAGMA table_info(spaces)').all() as { name: string }[]).map((c) => c.name)
      if (cols.includes('space') && cols.includes('chat_id')) {
        db.exec(SCHEMA)
        db.exec(`INSERT OR IGNORE INTO circles (chat_id, circle, added_by, added_at) SELECT chat_id, space, added_by, added_at FROM spaces`)
        db.exec('DROP TABLE spaces')
      }
    }
    db.exec(SCHEMA)
  }

  static validate(name: string): string | undefined {
    if (!CIRCLE_NAME_RE.test(name)) return '联盟名只能是中英文、数字、下划线、连字符，1–32 个字符'
    return undefined
  }

  /** 把群加进联盟（一个群只能在一个联盟里；再 join 就是换联盟）。 */
  join(chatId: string, circle: string, addedBy?: string): CircleMembership {
    this.db
      .prepare('INSERT INTO circles (chat_id, circle, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET circle = excluded.circle, added_by = excluded.added_by, added_at = excluded.added_at')
      .run(chatId, circle, addedBy ?? null, this.now())
    return this.get(chatId) as CircleMembership
  }

  leave(chatId: string): boolean {
    return Number(this.db.prepare('DELETE FROM circles WHERE chat_id = ?').run(chatId).changes) > 0
  }

  get(chatId: string): CircleMembership | undefined {
    const r = this.db.prepare('SELECT * FROM circles WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined
    return r ? { chatId: String(r.chat_id), circle: String(r.circle), addedBy: (r.added_by as string | null) ?? null, addedAt: Number(r.added_at) } : undefined
  }

  circleOf(chatId: string): string | undefined {
    return this.get(chatId)?.circle
  }

  /** 联盟里的所有群（含自己）。 */
  members(circle: string): string[] {
    return (this.db.prepare('SELECT chat_id FROM circles WHERE circle = ? ORDER BY added_at').all(circle) as { chat_id: string }[]).map((r) => r.chat_id)
  }

  /** 同联盟的其他群；不在任何联盟就是空数组。 */
  mates(chatId: string): string[] {
    const circle = this.circleOf(chatId)
    if (!circle) return []
    return this.members(circle).filter((id) => id !== chatId)
  }

  listAll(): { circle: string; chatIds: string[] }[] {
    const rows = this.db.prepare('SELECT circle, chat_id FROM circles ORDER BY circle, added_at').all() as { circle: string; chat_id: string }[]
    const out = new Map<string, string[]>()
    for (const r of rows) out.set(r.circle, [...(out.get(r.circle) ?? []), r.chat_id])
    return [...out.entries()].map(([circle, chatIds]) => ({ circle, chatIds }))
  }
}

/** 记忆作用域串 */
export function circleScope(name: string): string {
  return `circle:${name}`
}
