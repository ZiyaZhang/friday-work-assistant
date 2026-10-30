/**
 * 飞书发布门禁与具体发送账本。宿主提供完整、可信的本轮来源与固定目标；模型只产生正文。
 * 这里不追踪模型读过什么，也不授予跨空间披露权：缺来源或许可时拒绝发送。
 * planned / unknown 都可能已在远端生效，禁止自动重发；sent 仅重试回读。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OutboundPayload } from '../feishu/client.js'
import type { PolicyService } from './policy.js'
import type { AccessFailure } from './access-failure.js'
import { dmSpaceId, type Space, type Spaces } from './space.js'

export type DeliveryAudience =
  | { kind: 'group'; spaceId: string; chatId: string; replyToMessageId?: string; threadId?: string }
  | { kind: 'dm'; spaceId: string; openId: string }

export interface DeliverySource {
  /** 服务端登记的资源引用；不是模型声称的出处。 */
  ref: string
  spaceId: string
  /** 读取时绑定，空间换绑后旧结果不可投递。DM 尚无 chatId 时可为 null。 */
  chatId: string | null
}

export interface DeliveryDisclosureGrant {
  id: string
  sourceRef: string
  actorOpenId: string
  /** 用 deliveryAudienceKey 绑定精确空间及群 / 收件人，不接受通配符。 */
  audienceKey: string
  /** 已有明确发布指令可以形成许可，不要求再人工二次确认。 */
  grantedByOpenId: string
  expiresAt: number
}

export interface DeliveryContext {
  /** Host-only synchronous lease check, retained through Promise handoff; never persisted or signed. */
  isCurrent?: () => boolean
  actorOpenId: string
  audience: DeliveryAudience
  /** 包括 prompt、历史会话、记忆、工具、子任务；不能只选正文引用的子集。 */
  sources: readonly DeliverySource[]
  provenanceComplete: boolean
  expiresAt: number
  grants?: readonly DeliveryDisclosureGrant[]
  /** 可信宿主刚核对的本人读取权；仅用于把群资料回给此人，不授予向群披露权。 */
  personalRead?: { actorOpenId: string; chatIds: readonly string[]; expiresAt: number }
  /** 宿主在本次最终复验前取得的目标会话成员；缺省不生成原生 @。 */
  mentionOpenIds?: readonly string[]
}

export type DeliveryStatus = 'planned' | 'sent' | 'confirmed' | 'unknown'
/** 文件正文留在发送者的字节快照中；账本只记录名称、长度与内容摘要。 */
export type DeliveryPayload = OutboundPayload | { file: { name: string; sha256: string; size: number } }
export interface DeliveryRecord {
  key: string
  contextRef: string
  status: DeliveryStatus
  actorOpenId: string
  audience: DeliveryAudience
  sourceRefs: string[]
  grantIds: string[]
  payloadDigest: string
  remoteId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface DeliveryDependencies<P extends DeliveryPayload = OutboundPayload> {
  spaces: Spaces
  policy: PolicyService
  /**
   * 仅由可信宿主实现，逐次解析当前 actor/委托、完整来源、路由和未撤销的披露许可。
   * 缺 actor、旧 Run、取消、委托失效均返回 undefined。不得把 MCP body 映射成此对象。
   * 群成员新鲜度、消息/thread 归属由 resolver 核验；Spaces 本身只提供本地角色快照。
   */
  resolveContext: (contextRef: string) => Promise<DeliveryContext | undefined>
  /** 宿主同步业务准入：与新 planned 插入同事务、不可 await；抛错表示确定未派发。旧收据不重新准入。 */
  admit?: (input: { key: string; contextRef: string; context: DeliveryContext; payload: P }) => void
  /** 只能发送给传入 audience；适配器不能自行改群、收件人或回复锚点。 */
  send: (input: { audience: DeliveryAudience; payload: P; key: string; mentionOpenIds: readonly string[] }) => Promise<{ remoteId: string }>
  /** 只读回验：必须匹配实际远端 ID、目标受众与正文摘要，false/异常都不能冒充确认。 */
  verify?: (input: { audience: DeliveryAudience; remoteId: string; payloadDigest: string; key: string }) => Promise<boolean>
  now?: () => number
}

export class DeliveryError extends Error {
  constructor(readonly code: 'denied' | 'conflict' | 'unknown' | 'unconfirmed' | 'invalid', message: string, readonly failure?: AccessFailure) {
    super(message)
    this.name = 'DeliveryError'
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_key TEXT PRIMARY KEY,
  context_ref TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned', 'sent', 'confirmed', 'unknown')),
  actor_open_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  grant_ids TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  remote_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** 同一群的不同线程仍是同一受众；线程归属由可信 resolver 校验。 */
export function deliveryAudienceKey(audience: DeliveryAudience): string {
  return stableJson(audience.kind === 'group'
    ? { kind: audience.kind, spaceId: audience.spaceId, chatId: audience.chatId }
    : { kind: audience.kind, spaceId: audience.spaceId, openId: audience.openId })
}

/** Creates the ledger and adds later additive columns; existing rows and the status enum are untouched. */
export function ensureDeliverySchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
  const columns = db.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'reconciliation')) db.exec('ALTER TABLE deliveries ADD COLUMN reconciliation TEXT')
}

/** Last read-only reconciliation of a receipt: what the platform showed and when, never the payload. */
export interface DeliveryReconciliationSummary { result: string; checkedAt: number }
export interface DeliveryReceiptListItem {
  delivery_key: string
  status: DeliveryStatus
  remote_id: string | null
  reconciliation: DeliveryReconciliationSummary | null
}

/** Read receipts only for the selected context and, on human surfaces, its exact audience. */
export function listDeliveryReceipts(db: DatabaseSync, contexts: readonly string[], audience?: DeliveryAudience): DeliveryReceiptListItem[] {
  if (!contexts.length) return []
  const params = [...contexts]
  let filter = ''
  if (audience) {
    filter = ` AND json_extract(audience,'$.kind')=? AND json_extract(audience,'$.spaceId')=?
      AND json_extract(audience,'$.${audience.kind === 'group' ? 'chatId' : 'openId'}')=?`
    params.push(audience.kind, audience.spaceId, audience.kind === 'group' ? audience.chatId : audience.openId)
  }
  const rows = db.prepare(`SELECT delivery_key,status,remote_id,reconciliation FROM deliveries
    WHERE context_ref IN (${contexts.map(() => '?').join(',')})${filter} ORDER BY created_at,delivery_key`)
    .all(...params) as { delivery_key: string; status: DeliveryStatus; remote_id: string | null; reconciliation: string | null }[]
  return rows.map(({ reconciliation, ...row }) => ({ ...row, reconciliation: reconciliationSummary(reconciliation) }))
}

function reconciliationSummary(raw: string | null): DeliveryReconciliationSummary | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { result?: unknown; checkedAt?: unknown }
    return typeof parsed.result === 'string' && Number.isSafeInteger(parsed.checkedAt) ? { result: parsed.result, checkedAt: Number(parsed.checkedAt) } : null
  } catch { return null }
}

export function deliveryPayloadDigest(payload: DeliveryPayload): string {
  return digest(stableJson(payload))
}

/** Ledger row by key; metadata only, the payload body is never stored. */
export function readDeliveryRecord(db: DatabaseSync, key: string): DeliveryRecord | undefined {
  const r = db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(key) as Record<string, unknown> | undefined
  return r ? {
    key: String(r.delivery_key), contextRef: String(r.context_ref), status: r.status as DeliveryStatus,
    actorOpenId: String(r.actor_open_id), audience: JSON.parse(String(r.audience)) as DeliveryAudience,
    sourceRefs: JSON.parse(String(r.source_refs)) as string[], grantIds: JSON.parse(String(r.grant_ids)) as string[],
    payloadDigest: String(r.payload_digest), remoteId: r.remote_id == null ? null : String(r.remote_id),
    error: r.error == null ? null : String(r.error), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  } : undefined
}

export class DeliveryService<P extends DeliveryPayload = OutboundPayload> {
  private readonly now: () => number

  constructor(private readonly db: DatabaseSync, private readonly deps: DeliveryDependencies<P>) {
    ensureDeliverySchema(db)
    this.now = deps.now ?? Date.now
  }

  /** 元数据仅供可信宿主 / 运维读取；对用户暴露前仍需空间过滤。 */
  get(key: string): DeliveryRecord | undefined {
    return readDeliveryRecord(this.db, key)
  }

  /** 在创建承载正文的文档等副作用前预检；实际消息发送仍逐次重验。 */
  async check(contextRef: string): Promise<{ audience: DeliveryAudience; assertCurrent(): void }> {
    const context = await this.context(contextRef)
    const assertCurrent = () => this.authorize(context)
    assertCurrent()
    return { audience: structuredClone(context.audience), assertCurrent }
  }

  /** key 由宿主按 run/occurrence + 具体效果编号生成，重试不得换 key。正文改变必须另有新发布意图。 */
  async deliver(input: { key: string; contextRef: string; payload: P }): Promise<DeliveryRecord & { replayed: boolean }> {
    requireValue(input.key, 'delivery key')
    requireValue(input.contextRef, 'context ref')
    // 先复制，调用方不能在 await resolveContext 期间改变已核对的正文。
    const payload = JSON.parse(stableJson(input.payload)) as P
    const payloadDigest = deliveryPayloadDigest(payload)
    const context = await this.context(input.contextRef)
    this.authorize(context)
    const signature = this.signature(input.contextRef, context, payloadDigest)
    const existing = this.get(input.key)
    if (existing) {
      this.assertSignature(input.key, signature)
      return { ...await this.finishExisting(existing), replayed: true }
    }
    const now = this.now()
    let inserted = false
    this.db.exec('SAVEPOINT delivery_admission')
    try {
      const result: unknown = this.deps.admit?.({ key: input.key, contextRef: input.contextRef, context, payload })
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new DeliveryError('invalid', '投递准入必须同步完成')
      }
      inserted = Number(this.db.prepare(`INSERT OR IGNORE INTO deliveries
        (delivery_key, context_ref, signature, status, actor_open_id, audience, source_refs, grant_ids, payload_digest, created_at, updated_at)
        VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`).run(
        input.key, input.contextRef, signature, context.actorOpenId, stableJson(context.audience),
        JSON.stringify(context.sources.map((s) => s.ref).sort()), JSON.stringify((context.grants ?? []).map((g) => g.id).sort()), payloadDigest, now, now,
      ).changes) > 0
      this.db.exec('RELEASE delivery_admission')
    } catch (error) {
      this.db.exec('ROLLBACK TO delivery_admission; RELEASE delivery_admission')
      throw error
    }
    if (!inserted) {
      this.assertSignature(input.key, signature)
      return { ...await this.finishExisting(this.get(input.key)!), replayed: true }
    }
    // 无 await / 网络位于授权检查与发送占位之间；UNIQUE key 让多个 store 实例也只有一个发送者。
    try {
      const sent = await this.deps.send({ audience: context.audience, payload, key: input.key, mentionOpenIds: context.mentionOpenIds ?? [] })
      requireValue(sent.remoteId, 'remote ID')
      const changed = this.db.prepare("UPDATE deliveries SET status = 'sent', remote_id = ?, updated_at = ? WHERE delivery_key = ? AND status = 'planned'").run(sent.remoteId, this.now(), input.key)
      if (!Number(changed.changes)) throw new DeliveryError('unknown', '发送已开始但回执状态发生变化，须核对远端')
    } catch {
      this.db.prepare("UPDATE deliveries SET status = 'unknown', error = 'send_result_unknown', updated_at = ? WHERE delivery_key = ? AND status = 'planned'").run(this.now(), input.key)
      throw new DeliveryError('unknown', '发送结果未知，须核对远端；不会自动重发')
    }
    return { ...await this.finishExisting(this.get(input.key)!), replayed: false }
  }

  /** 仅在启动且没有活动发送者时调用。sent 保留远端 ID，planned 不猜测是否已发送。 */
  recoverInterrupted(): number {
    return Number(this.db.prepare("UPDATE deliveries SET status = 'unknown', error = 'interrupted_before_receipt', updated_at = ? WHERE status = 'planned'").run(this.now()).changes)
  }

  /** 明确对账入口，remoteId 来自可信远端查证；仅 GET 验证，不提供 resend/reset。 */
  async reconcile(key: string, remoteId: string): Promise<DeliveryRecord> {
    requireValue(remoteId, 'remote ID')
    const record = this.get(key)
    if (!record) throw new DeliveryError('invalid', '找不到发送记录')
    const context = await this.context(record.contextRef)
    this.authorize(context)
    this.assertSignature(key, this.signature(record.contextRef, context, record.payloadDigest))
    if (record.remoteId && record.remoteId !== remoteId) throw new DeliveryError('conflict', '远端 ID 与已有回执不同')
    if (record.status === 'confirmed') return record
    if (record.status === 'planned') throw new DeliveryError('unknown', '发送可能仍在进行；先停机核对或恢复中断记录')
    await this.verify(record, remoteId)
    this.db.prepare("UPDATE deliveries SET status = 'confirmed', remote_id = ?, error = NULL, updated_at = ? WHERE delivery_key = ? AND status IN ('sent', 'unknown') AND (remote_id IS NULL OR remote_id = ?)").run(remoteId, this.now(), key, remoteId)
    const confirmed = this.get(key)!
    if (confirmed.status !== 'confirmed' || confirmed.remoteId !== remoteId) throw new DeliveryError('conflict', '对账期间已有其他回执，不能覆盖')
    return confirmed
  }

  private async context(ref: string): Promise<DeliveryContext> {
    const resolved = await this.deps.resolveContext(ref)
    if (!resolved) throw new DeliveryError('denied', '当前执行身份或委托已失效')
    const { isCurrent, ...data } = resolved
    return { ...JSON.parse(stableJson(data)), ...(isCurrent ? { isCurrent } : {}) } as DeliveryContext
  }

  private authorize(c: DeliveryContext): void {
    if (c.isCurrent && !c.isCurrent()) throw new DeliveryError('denied', '当前执行、授权或来源已变化')
    if (!c.actorOpenId?.trim() || !c.provenanceComplete || !c.sources?.length || !Number.isFinite(c.expiresAt) || c.expiresAt <= this.now()) throw new DeliveryError('denied', '缺少当前身份、完整可信来源或有效发布上下文')
    const target = this.deps.spaces.get(c.audience.spaceId)
    this.active(target)
    if (c.audience.kind === 'group') {
      if (target.kind !== 'group' || !c.audience.chatId || target.chatId !== c.audience.chatId) throw new DeliveryError('denied', '目标群已换绑或不属于该空间')
    } else if (c.audience.kind !== 'dm' || target.kind !== 'p2p' || target.id !== dmSpaceId(c.actorOpenId) || c.audience.openId !== c.actorOpenId) {
      throw new DeliveryError('denied', '私聊投递仅支持当前本人，不能继承他人身份')
    }
    this.member(target, c.actorOpenId)
    this.allowed(target.id, c.actorOpenId, 'publish', 'here')
    const refs = new Set<string>()
    for (const source of c.sources) {
      if (!source.ref?.trim() || refs.has(source.ref)) throw new DeliveryError('denied', '来源引用缺失或重复')
      refs.add(source.ref)
      const space = this.deps.spaces.get(source.spaceId)
      const personal = c.audience.kind === 'dm' && source.chatId && c.personalRead?.actorOpenId === c.actorOpenId &&
        c.personalRead.chatIds.includes(source.chatId) && Number.isFinite(c.personalRead.expiresAt) && c.personalRead.expiresAt > this.now()
      // 部分获准读取的飞书群尚未初始化 Friday 空间；只回本人时，当前平台读取权已足够。
      // 一旦存在 Friday 空间，停用 / 换绑仍使原授权失效。
      if (personal) {
        if (space) {
          this.active(space)
          if (space.chatId !== source.chatId) throw new DeliveryError('denied', '来源空间已换绑')
        }
        continue
      }
      this.active(space)
      if (space.chatId !== source.chatId || (space.kind === 'group' && !source.chatId)) throw new DeliveryError('denied', '来源空间已换绑')
      this.member(space, c.actorOpenId)
      this.allowed(space.id, c.actorOpenId, 'read')
      const crossing = space.id !== target.id
      if (!crossing) {
        this.allowed(space.id, c.actorOpenId, 'publish', 'here')
        continue
      }
      const grant = c.grants?.find((g) => g.id?.trim() && g.sourceRef === source.ref && g.actorOpenId === c.actorOpenId &&
        g.audienceKey === deliveryAudienceKey(c.audience) && Number.isFinite(g.expiresAt) && g.expiresAt > this.now() &&
        this.deps.spaces.roleOf(space.id, g.grantedByOpenId) === 'owner' && (space.kind !== 'p2p' || space.id === dmSpaceId(g.grantedByOpenId)))
      if (!grant) throw new DeliveryError('denied', '缺少当前来源到该受众的有效披露许可')
      // 有效明确许可满足 ask；部署 deny 仍不可绕过，不机械要求再次确认。
      const gate = this.deps.policy.decide({ spaceId: space.id, openId: c.actorOpenId, action: 'publish', target: 'cross-space' })
      if (gate.decision === 'deny') throw new DeliveryError('denied', gate.reason)
    }
  }

  private active(space: Space | undefined): asserts space is Space {
    if (!space || space.status !== 'active') throw new DeliveryError('denied', '来源或目标空间不存在或已停用')
  }

  private member(space: Space, actor: string): void {
    if (!this.deps.spaces.roleOf(space.id, actor) || (space.kind === 'p2p' && space.id !== dmSpaceId(actor))) throw new DeliveryError('denied', '当前身份不是该空间成员')
  }

  private allowed(spaceId: string, actor: string, action: 'read' | 'publish', target?: 'here'): void {
    const gate = this.deps.policy.decide({ spaceId, openId: actor, action, target })
    if (gate.decision !== 'allow') throw new DeliveryError('denied', gate.reason)
  }

  private signature(contextRef: string, context: DeliveryContext, payloadDigest: string): string {
    return digest(stableJson({ contextRef, actor: context.actorOpenId, audience: context.audience, sources: [...context.sources].sort((a, b) => a.ref.localeCompare(b.ref)), payloadDigest }))
  }

  private assertSignature(key: string, signature: string): void {
    const r = this.db.prepare('SELECT signature FROM deliveries WHERE delivery_key = ?').get(key) as { signature: string } | undefined
    if (!r || r.signature !== signature) throw new DeliveryError('conflict', '发送 key 已用于不同身份、来源、目标或正文')
  }

  private async finishExisting(record: DeliveryRecord): Promise<DeliveryRecord> {
    if (record.status === 'confirmed') return record
    if (record.status === 'planned' || record.status === 'unknown' || !record.remoteId) throw new DeliveryError('unknown', '发送结果未知或正在发送，须核对远端；不会自动重发')
    if (!this.deps.verify) return record // API ACK 只证明 sent，不冒充回读 confirmed。
    await this.verify(record, record.remoteId)
    this.db.prepare("UPDATE deliveries SET status = 'confirmed', error = NULL, updated_at = ? WHERE delivery_key = ? AND status = 'sent' AND remote_id = ?").run(this.now(), record.key, record.remoteId)
    return this.get(record.key)!
  }

  private async verify(record: DeliveryRecord, remoteId: string): Promise<void> {
    try {
      if (this.deps.verify && await this.deps.verify({ audience: record.audience, remoteId, payloadDigest: record.payloadDigest, key: record.key })) return
    } catch {
      throw new DeliveryError('unconfirmed', '远端回读失败，发送结果待核对；不会重新发送')
    }
    throw new DeliveryError('unconfirmed', '尚未核实远端消息的受众与正文')
  }
}

function requireValue(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new DeliveryError('invalid', `${label} 缺失或过长`)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
}
