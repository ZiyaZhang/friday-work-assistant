/**
 * 已单独提醒过的对象（G8）：跨输出只按稳定编号判重，不做文本相似度。
 *
 * - 只登记四种编号：todo:<id>、inbox:<id>、msg:<message_id>、gh:<owner/repo>#<n>；别的一律忽略。
 * - 在投递 ACK 之后由宿主登记本轮实际引用过的对象（从投递正文里取显式编号，或宿主自己就知道的编号）；
 *   投递失败、结果未知的不登记。
 * - 日报的 prompt 附上近 24 小时已单独提醒过的编号，让模型在那一条末尾标注「已单独提醒」，而不是删掉它。
 */
import type { DatabaseSync } from 'node:sqlite'

export const REPORTED_REF_WINDOW_MS = 24 * 3600_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reported_refs (
  owner_open_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  output_key TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (owner_open_id, ref, output_key)
);
`

/** 只建表；旧库没有这张表时从空表开始，不回填任何历史提醒。 */
export function ensureReportedRefsSchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
}

const STABLE_REF = /^(?:todo:[1-9]\d*|inbox:[1-9]\d*|msg:om_[A-Za-z0-9_-]+|gh:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*)$/

/** 规范化：gh 的仓库名统一小写；不是四种编号之一返回 undefined。 */
export function normalizeStableRef(raw: string): string | undefined {
  const ref = raw.trim()
  if (!STABLE_REF.test(ref)) return undefined
  if (!ref.startsWith('gh:')) return ref
  const hash = ref.lastIndexOf('#')
  return `gh:${ref.slice(3, hash).toLowerCase()}#${ref.slice(hash + 1)}`
}

const PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => string }[] = [
  { re: /\btodo:([1-9]\d*)\b/g, make: m => `todo:${m[1]}` },
  { re: /\binbox:([1-9]\d*)\b/g, make: m => `inbox:${m[1]}` },
  { re: /\bmsg:(om_[A-Za-z0-9_-]+)/g, make: m => `msg:${m[1]}` },
  { re: /\bgh:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)\b/g, make: m => `gh:${m[1]}#${m[2]}` },
  { re: /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)\b/g, make: m => `gh:${m[1]}/${m[2]}#${m[3]}` },
  // 裸的 owner/repo#n；前面紧挨着路径分隔符或冒号的（gh:… 或更深的路径）不算。
  { re: /(?<![\w/.:-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)\b/g, make: m => `gh:${m[1]}#${m[2]}` },
]

/** 从投递正文里取显式写出的稳定编号；去重、按出现顺序。裸的 #12 不算——分不清是待办还是 Issue。 */
export function extractStableRefs(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const { re, make } of PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const ref = normalizeStableRef(make(m))
      if (ref && !seen.has(ref)) { seen.add(ref); out.push(ref) }
    }
  }
  return out
}

export interface ReportedRef {
  ref: string
  outputKey: string
  deliveredAt: number
}

export class ReportedRefs {
  constructor(private readonly db: DatabaseSync) {
    ensureReportedRefsSchema(db)
  }

  /**
   * 投递 ACK 之后登记。非法编号忽略；同一 (owner, ref, output) 重复登记不改时间。返回新登记的条数。
   * ownerOpenId 是这次投递以谁的身份 / 给谁：私聊提醒是收件人，群里的职责简报是职责的 run_as。
   */
  record(input: { ownerOpenId: string; refs: readonly string[]; outputKey: string; deliveredAt: number }): number {
    const owner = input.ownerOpenId?.trim(), outputKey = input.outputKey?.trim()
    if (!owner || !outputKey || !Number.isSafeInteger(input.deliveredAt)) return 0
    const refs = [...new Set(input.refs.map(normalizeStableRef).filter((ref): ref is string => Boolean(ref)))]
    if (!refs.length) return 0
    const stmt = this.db.prepare('INSERT OR IGNORE INTO reported_refs (owner_open_id, ref, output_key, delivered_at) VALUES (?, ?, ?, ?)')
    let inserted = 0
    for (const ref of refs) inserted += Number(stmt.run(owner, ref, outputKey, input.deliveredAt).changes)
    return inserted
  }

  /** 这个人在 sinceMs 之后（含）已单独提醒过的编号，每个编号只取最近一次；可排除某个前缀的输出（例如同一条职责自己的简报）。 */
  recent(ownerOpenId: string, sinceMs: number, opts: { excludeOutputPrefix?: string } = {}): ReportedRef[] {
    const rows = this.db.prepare('SELECT ref, output_key, delivered_at FROM reported_refs WHERE owner_open_id = ? AND delivered_at >= ? ORDER BY delivered_at DESC, ref')
      .all(ownerOpenId, sinceMs) as { ref: string; output_key: string; delivered_at: number }[]
    const latest = new Map<string, ReportedRef>()
    for (const row of rows) {
      if (opts.excludeOutputPrefix && row.output_key.startsWith(opts.excludeOutputPrefix)) continue
      if (!latest.has(row.ref)) latest.set(row.ref, { ref: row.ref, outputKey: row.output_key, deliveredAt: Number(row.delivered_at) })
    }
    return [...latest.values()]
  }
}
