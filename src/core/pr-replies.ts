/**
 * PR 新回复的暂存与合批。只存在 kv 里，不加表：每个 PR 一条记录，等待判定的回复最多留 30 分钟，判定后只留摘要。
 *
 * - 起点：功能第一次跑的时刻（全局一次）。之前的旧回复不回放，也不补发。
 * - 合批：一个 PR 的新回复在最后一条之后安静 5 分钟再一起判定；最早一条等满 30 分钟就不再等。
 * - 判定记录（规则版本、结论、理由、引文）留最近 50 条，用来回答"为什么没推这条"。
 */
import { PR_REPLY_POLICY, type PrReplyDecision, type PrReplyItem } from './pr-reply-judge.js'

export const PR_REPLY_QUIET_MS = 5 * 60_000
export const PR_REPLY_MAX_WAIT_MS = 30 * 60_000
const MAX_PENDING = 40, MAX_SEEN = 400, MAX_LOG = 50

interface Pending extends PrReplyItem { seenAt: number }
export interface PrReplyLogEntry { key: string; author: string; decision: string; reason: string; quote?: string; source: string; policy: string; decidedAt: number; delivered: boolean }
interface State { since: number; pending: Pending[]; seen: string[]; log: PrReplyLogEntry[] }

export interface KvAccess { get(key: string): string | undefined; set(key: string, value: string): void }

export class PrReplyStore {
  constructor(private readonly kv: KvAccess, private readonly now: () => number = Date.now) {}

  /** Set once, the first time the feature runs; replies created before it are never delivered. */
  boundary(): number {
    const stored = Number(this.kv.get('pr-replies:boundary'))
    if (Number.isSafeInteger(stored) && stored > 0) return stored
    const now = this.now()
    this.kv.set('pr-replies:boundary', String(now))
    return now
  }

  /** Where the next GitHub read for this PR starts. */
  since(changeId: string): number { return this.load(changeId).since }

  /** Records new replies once each; replies from before the boundary or already seen are dropped. Returns how many were new. */
  add(changeId: string, items: readonly PrReplyItem[]): number {
    const state = this.load(changeId), now = this.now(), seen = new Set(state.seen)
    let added = 0
    for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
      if (item.createdAt <= this.boundary() || seen.has(item.key)) continue
      seen.add(item.key); state.seen.push(item.key)
      state.pending.push({ ...item, seenAt: now })
      state.since = Math.max(state.since, item.createdAt)
      added += 1
    }
    // A flood of replies is judged in the order it came; the oldest overflow is dropped rather than growing the record.
    state.pending = state.pending.slice(-MAX_PENDING)
    state.seen = state.seen.slice(-MAX_SEEN)
    this.save(changeId, state)
    return added
  }

  /** The pending batch when it is due: quiet for 5 minutes since its newest reply, or its oldest has waited 30 minutes. */
  due(changeId: string): PrReplyItem[] {
    const { pending } = this.load(changeId), now = this.now()
    if (!pending.length) return []
    const newest = Math.max(...pending.map(item => item.createdAt)), oldest = Math.min(...pending.map(item => item.seenAt))
    if (now - newest < PR_REPLY_QUIET_MS && now - oldest < PR_REPLY_MAX_WAIT_MS) return []
    return pending.map(({ seenAt: _seenAt, ...item }) => item)
  }

  /** Removes the judged batch and keeps a short decision record; reply bodies are not kept. */
  settle(changeId: string, batch: readonly PrReplyItem[], decisions: ReadonlyMap<string, PrReplyDecision>, delivered: boolean): void {
    const state = this.load(changeId), keys = new Set(batch.map(item => item.key)), now = this.now()
    state.pending = state.pending.filter(item => !keys.has(item.key))
    for (const item of batch) {
      const decision = decisions.get(item.key)
      if (!decision) continue
      state.log.push({ key: item.key, author: item.author, decision: decision.decision, reason: decision.reason,
        ...(decision.quote ? { quote: decision.quote.slice(0, 300) } : {}), source: decision.source, policy: PR_REPLY_POLICY, decidedAt: now,
        delivered: delivered && decision.decision !== 'quiet' })
    }
    state.log = state.log.slice(-MAX_LOG)
    this.save(changeId, state)
  }

  log(changeId: string): PrReplyLogEntry[] { return this.load(changeId).log }

  private load(changeId: string): State {
    try {
      const value = JSON.parse(this.kv.get(`pr-replies:${changeId}`) ?? '') as State
      if (Number.isSafeInteger(value.since) && Array.isArray(value.pending) && Array.isArray(value.seen) && Array.isArray(value.log)) return value
    } catch { /* first time for this PR */ }
    return { since: this.boundary(), pending: [], seen: [], log: [] }
  }

  private save(changeId: string, state: State): void { this.kv.set(`pr-replies:${changeId}`, JSON.stringify(state)) }
}
