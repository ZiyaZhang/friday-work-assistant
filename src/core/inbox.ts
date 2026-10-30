/**
 * 收件箱：等人拍板的事。
 *
 * 待确认事项优先在已有对话中顺带提醒，减少单独打扰。回答当前问题后，
 * 它答完在末尾捎一句「另外有两件事等你拍板（都是之前积压的）」。
 * 单独推送会被当成骚扰然后被无视；蹭一次已有的对话，几乎零成本。
 *
 * 这里只管「有哪些待办决定、什么时候该捎带、捎带过就别再烦」。
 * 提案本身还是各自的表（routines 的职责提案、skills 的 skill 提案……），
 * 这里存的是**指针**，不重复存内容——两份内容迟早会不一致。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type PendingKind = 'responsibility' | 'skill' | 'auth' | 'bug' | 'decision' | 'other'
/**
 * 怎么结清的：本人说“定了” / “不用了”，或所属领域自己的状态变了（提案被接受、授权恢复、职责删除……）。
 * 领域指针只能由领域结清；独立的待决断才由本人在这里结清。
 */
export type PendingResolution = 'decided' | 'dropped' | 'domain'

/**
 * 「这一轮我停下来等你定」的稳定编号。
 *
 * 同一个问题问两次不该变成两条。没有天然的外键可用（问题本身不在任何表里），
 * 个人问题按 (发起人, 空间, 问题) 算稳定编号；旧的领域链接保持原编号。
 */
export function decisionRef(spaceId: string | undefined, question: string, ownerOpenId?: string): number {
  // 去掉**所有**空白再算，不只是合并连续空白：只差一个换行或空格的两句话是同一个问题，
  // 而模型重述时空格换行很容易变。标题照原样存，规范化只用于这个去重编号。
  const key = `${spaceId ?? ''}\u0000${question.replace(/\s+/g, '')}`
  // Keep legacy refs stable for existing domain links; new personal decisions
  // bind the owner as well as the space and question.
  const digest = createHash('sha1').update(ownerOpenId === undefined ? key : JSON.stringify([ownerOpenId, key])).digest()
  // 取 6 字节，稳稳落在安全整数内
  return digest.readUIntBE(0, 6)
}

export interface PendingItem {
  id: number
  /** 谁该拍板 */
  ownerOpenId: string
  kind: PendingKind
  /** 指向原表的编号（routines.id / skill_proposals.id …） */
  refId: number | null
  /** 这件事是在哪个空间里产生的。群里捎带时只捎带**本空间**的，
   *  否则私聊里攒的事会被顺手贴进群，等于替人泄密。null = 不限（私聊才捎带）。 */
  spaceId: string | null
  title: string
  /** 一句话说明为什么需要他 */
  why: string | null
  createdAt: number
  /** 上次捎带提醒的时间；null = 还没提过 */
  lastNudgedAt: number | null
  nudges: number
  resolvedAt: number | null
  /** 同一 (kind, refId) 结清后又重新等人时加一；结清必须针对当前这一版，旧引用不能关掉新的一版。 */
  version: number
  resolution: PendingResolution | null
  resolvedBy: string | null
  /** 本人的结论原话（“按 P2”），或领域结清时的去向（accepted / ignored / expired / deleted …） */
  resolutionNote: string | null
}

/** 同一件事最多捎带几次。再多就是骚扰，而且说明他就是不想理。 */
export const MAX_NUDGES = 3
/** 两次捎带之间至少隔多久 */
export const NUDGE_COOLDOWN_MS = 12 * 3600_000
/** 刚建出来的先放一会儿，别答完上一句就立刻催 */
export const NUDGE_DELAY_MS = 30 * 60_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_open_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  space_id TEXT,
  title TEXT NOT NULL,
  why TEXT,
  created_at INTEGER NOT NULL,
  last_nudged_at INTEGER,
  nudges INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbox_owner ON inbox_items(owner_open_id, resolved_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_ref ON inbox_items(kind, ref_id) WHERE ref_id IS NOT NULL;
`

export class Inbox {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    // 只加列：旧行 version=1、没有结论记录，已结清的旧行保持结清，不回填任何猜测的结论或决定人。
    const cols = new Set((db.prepare('PRAGMA table_info(inbox_items)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('version')) db.exec('ALTER TABLE inbox_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    if (!cols.has('resolution')) db.exec('ALTER TABLE inbox_items ADD COLUMN resolution TEXT')
    if (!cols.has('resolved_by')) db.exec('ALTER TABLE inbox_items ADD COLUMN resolved_by TEXT')
    if (!cols.has('resolution_note')) db.exec('ALTER TABLE inbox_items ADD COLUMN resolution_note TEXT')
  }

  /**
   * 登记一件等人拍板的事。同一个 (kind, refId) 重复登记不会变成两条。
   * 已经结清的同一件事又在等同一个人（授权再次到期、同一句问题再问一次）：同一行开新的一版，
   * 旧结论不带过来，捎带次数从头算。别人的行不会被接管。
   */
  add(input: { ownerOpenId: string; kind: PendingKind; refId?: number; spaceId?: string; title: string; why?: string; now?: number }): PendingItem {
    const now = input.now ?? Date.now()
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200), why = input.why?.trim().slice(0, 300) ?? null
    if (input.refId !== undefined) {
      const existing = this.db.prepare('SELECT * FROM inbox_items WHERE kind = ? AND ref_id = ?').get(input.kind, input.refId) as Record<string, unknown> | undefined
      if (existing) {
        const item = toItem(existing)
        if (item.resolvedAt === null || item.ownerOpenId !== input.ownerOpenId) return item
        this.db.prepare(`UPDATE inbox_items SET version = version + 1, resolved_at = NULL, resolution = NULL, resolved_by = NULL, resolution_note = NULL,
          title = ?, why = ?, space_id = ?, created_at = ?, last_nudged_at = NULL, nudges = 0 WHERE id = ? AND resolved_at IS NOT NULL`)
          .run(title, why, input.spaceId ?? null, now, item.id)
        return this.get(item.id) as PendingItem
      }
    }
    const res = this.db
      .prepare('INSERT INTO inbox_items (owner_open_id, kind, ref_id, space_id, title, why, created_at, nudges) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(input.ownerOpenId, input.kind, input.refId ?? null, input.spaceId ?? null, title, why, now)
    return this.get(Number(res.lastInsertRowid)) as PendingItem
  }

  /** 按 (kind, refId) 找，用来判断"这件事是不是已经在等他了"。 */
  find(kind: PendingKind, refId: number, ownerOpenId?: string): PendingItem | undefined {
    const r = (ownerOpenId === undefined
      ? this.db.prepare('SELECT * FROM inbox_items WHERE kind = ? AND ref_id = ?').get(kind, refId)
      : this.db.prepare('SELECT * FROM inbox_items WHERE kind = ? AND ref_id = ? AND owner_open_id = ?').get(kind, refId, ownerOpenId)) as Record<string, unknown> | undefined
    return r ? toItem(r) : undefined
  }

  get(id: number): PendingItem | undefined {
    const r = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toItem(r) : undefined
  }

  pending(ownerOpenId: string): PendingItem[] {
    const rows = this.db.prepare('SELECT * FROM inbox_items WHERE owner_open_id = ? AND resolved_at IS NULL ORDER BY created_at').all(ownerOpenId) as Record<string, unknown>[]
    return rows.map(toItem)
  }

  /** 领域状态变了，指针跟着结清（提案被接受 / 忽略 / 作废 / 删除，授权恢复……）。只由所属领域调用。 */
  resolve(kind: PendingKind, refId: number, nowMs = Date.now(), outcome: { by?: string; note?: string } = {}): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET resolved_at = ?, resolution = 'domain', resolved_by = ?, resolution_note = ?
      WHERE kind = ? AND ref_id = ? AND resolved_at IS NULL`).run(nowMs, outcome.by ?? null, outcome.note ?? null, kind, refId).changes) > 0
  }

  /**
   * 本人结清一条独立的待决断：条件更新，只结清仍在等、且还是调用方看到的那一版的这一行。
   * 身份、空间和领域归属由应用层先核对；这里只保证不会关掉新的一版或已经结清的行。
   */
  settle(input: { id: number; version: number; resolution: Exclude<PendingResolution, 'domain'>; by: string; note?: string; now?: number }): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET resolved_at = ?, resolution = ?, resolved_by = ?, resolution_note = ?
      WHERE id = ? AND version = ? AND resolved_at IS NULL`)
      .run(input.now ?? Date.now(), input.resolution, input.by, input.note?.trim().slice(0, 300) || null, input.id, input.version).changes) > 0
  }

  /** 领域内容改了（比如提案改了名字或频率），指针上的标题跟着改；已结清的不动。 */
  retitle(kind: PendingKind, refId: number, title: string): boolean {
    return Number(this.db.prepare('UPDATE inbox_items SET title = ? WHERE kind = ? AND ref_id = ? AND resolved_at IS NULL')
      .run(title.replace(/\s+/g, ' ').trim().slice(0, 200), kind, refId).changes) > 0
  }

  resolveById(id: number, nowMs = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE inbox_items SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(nowMs, id).changes) > 0
  }

  /**
   * 这次回复末尾该不该捎带，捎带哪些。**只读，不记账**——
   * 因为答案可能最终没发出去（模型改主意了、任务失败了）。
   * 真发出去了再调 markNudged。
   */
  dueFor(ownerOpenId: string, nowMs = Date.now(), opts: { spaceId?: string } = {}): PendingItem[] {
    return this.pending(ownerOpenId).filter((it) => {
      // 群里只捎带本空间的事：私聊里攒的（比如别的群的盯群授权）贴进群等于替人泄密
      if (opts.spaceId && it.spaceId !== opts.spaceId) return false
      if (it.nudges >= MAX_NUDGES) return false
      if (nowMs - it.createdAt < NUDGE_DELAY_MS) return false
      if (it.lastNudgedAt !== null && nowMs - it.lastNudgedAt < NUDGE_COOLDOWN_MS) return false
      return true
    })
  }

  markNudged(ids: number[], nowMs = Date.now()): void {
    for (const id of ids) this.db.prepare('UPDATE inbox_items SET nudges = nudges + 1, last_nudged_at = ? WHERE id = ?').run(nowMs, id)
  }

  /** 捎带在回答末尾的那一句。刻意短：它是附带的，不是主角。 */
  static renderNudge(items: PendingItem[], nowMs = Date.now()): string {
    if (!items.length) return ''
    const head = items.length === 1 ? '另外有一件事等你拍板' : `另外有 ${items.length} 件事等你拍板`
    const aged = items.every((i) => nowMs - i.createdAt > 3 * 86400_000) ? '（都是之前积压的）' : ''
    const lines = items.slice(0, 3).map((i, n) => `${n + 1}. ${i.title}${i.why ? `——${i.why}` : ''}`)
    return `\n\n---\n${head}${aged}：\n${lines.join('\n')}`
  }
}

function toItem(r: Record<string, unknown>): PendingItem {
  return {
    id: Number(r.id),
    ownerOpenId: String(r.owner_open_id),
    kind: r.kind as PendingKind,
    refId: r.ref_id === null || r.ref_id === undefined ? null : Number(r.ref_id),
    spaceId: (r.space_id as string | null) ?? null,
    title: String(r.title),
    why: (r.why as string | null) ?? null,
    createdAt: Number(r.created_at),
    lastNudgedAt: r.last_nudged_at === null || r.last_nudged_at === undefined ? null : Number(r.last_nudged_at),
    nudges: Number(r.nudges ?? 0),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    version: r.version === null || r.version === undefined ? 1 : Number(r.version),
    resolution: r.resolution === 'decided' || r.resolution === 'dropped' || r.resolution === 'domain' ? r.resolution : null,
    resolvedBy: (r.resolved_by as string | null | undefined) ?? null,
    resolutionNote: (r.resolution_note as string | null | undefined) ?? null,
  }
}
