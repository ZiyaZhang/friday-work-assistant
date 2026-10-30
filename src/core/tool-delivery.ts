/** 工具交付复用宿主投递门禁；上传成功不等于用户已收到文件。 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FeishuClient } from '../feishu/client.js'
import { DeliveryError, DeliveryService, type DeliveryAudience, type DeliveryContext, type DeliveryPayload, type DeliveryRecord, type DeliveryStatus } from './delivery.js'
import type { PolicyService } from './policy.js'
import type { Spaces } from './space.js'

export type ToolDeliveryInput =
  | { kind: 'file'; data: Buffer; name: string; note?: string }
  | { kind: 'message'; text: string }

export type ToolDeliveryReceipt = DeliveryRecord & { replayed: boolean }
export interface ToolDeliveryResult {
  delivery: ToolDeliveryReceipt
  note?: DeliveryRecord
  noteStatus?: DeliveryStatus | 'not_sent'
}
export interface ToolDeliveryDependencies {
  spaces: Spaces
  policy: PolicyService
  feishu: Pick<FeishuClient, 'uploadFile' | 'replyFile' | 'sendFileToUser' | 'sendFileToChat' | 'replyMarkdown' | 'sendToUser' | 'sendToChat'>
  /** 都来自宿主当前任务，不能由工具参数 / 模型指定。 */
  contextRef: string
  keyPrefix: string
  resolveContext: (privateMessage: boolean) => Promise<DeliveryContext | undefined>
  assertCurrent: () => void
  /** watch 在 POST 前持久绑定已完整读取的窗口；同步，不执行网络操作。 */
  beforePrimarySend?: (deliveryKey: string) => void
  now?: () => number
}

export class ToolDeliveryService {
  private readonly ledger: DeliveryService<DeliveryPayload>
  private readonly pending = new Set<Promise<unknown>>()
  private readonly effects = new Map<string, Promise<ToolDeliveryReceipt>>()
  private readonly pendingPrimary = new Set<Promise<ToolDeliveryReceipt>>()
  private readonly requestedNotes = new Set<string>()
  private readonly prefix: string
  private closed = false
  private invalidated = false

  constructor(private readonly db: DatabaseSync, private readonly deps: ToolDeliveryDependencies) {
    for (const value of [deps.contextRef, deps.keyPrefix]) {
      if (!value.trim() || value.length > 350) throw new DeliveryError('invalid', '工具投递缺少当前任务标识或标识过长')
    }
    this.prefix = `${deps.keyPrefix}:tool:`
    // 创建表并提供只读 get；真实发送使用本次调用绑定的适配器。
    this.ledger = new DeliveryService<DeliveryPayload>(db, {
      ...deps, resolveContext: async () => undefined,
      send: async () => { throw new DeliveryError('invalid', '没有绑定工具交付') },
    })
  }

  /** message 固定回本人；可选材料断言仅由宿主传入，贯穿本次发送与共享结果的返回。 */
  send(input: ToolDeliveryInput, privateMessage = false, assertMaterial?: () => void): Promise<ToolDeliveryResult> {
    if (this.closed) return Promise.reject(new DeliveryError('denied', '当前任务已开始收尾，不能新增工具交付'))
    // 工具调用之后的字节变动不能改变已经计算摘要和检查的文件。
    const snapshot = input.kind === 'file' ? { ...input, data: Buffer.from(input.data) } : { ...input }
    const operation = this.perform(snapshot, input.kind === 'message' || privateMessage, assertMaterial).then(result => {
      this.assertMaterial(assertMaterial)
      return result
    })
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  /** 问题 ID 来自宿主登记；原话题投递，与工具结果共用收尾和取消机制。 */
  sendQuestion(questionId: number, text: string): Promise<ToolDeliveryResult> {
    if (this.closed) return Promise.reject(new DeliveryError('denied', '当前任务已开始收尾，不能新增补问'))
    if (!Number.isSafeInteger(questionId) || questionId <= 0 || !text.trim()) return Promise.reject(new DeliveryError('invalid', '补问内容或登记编号无效'))
    const operation = this.effect(`question:${questionId}`, { markdown: text }, false).then((delivery) => ({ delivery }))
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  /** 仅当前宿主任务；sent 是平台 ACK，不声称用户已读或业务已完成。 */
  receipts(): DeliveryRecord[] {
    const rows = this.db.prepare(`SELECT delivery_key FROM deliveries
      WHERE context_ref IN (?, ?) AND (substr(delivery_key, 1, ?) = ? OR delivery_key LIKE 'question:%') ORDER BY created_at, delivery_key`).all(
      this.contextRef(false), this.contextRef(true), this.prefix.length, this.prefix,
    ) as { delivery_key: string }[]
    return rows.map((row) => this.ledger.get(row.delivery_key)!)
  }

  /** 主交付和附言分别判断，附言未知不能抹去已收到平台 ACK 的文件。 */
  primaryReceipts(): DeliveryRecord[] {
    return this.receipts().filter((record) => this.isPrimaryKey(record.key))
  }

  /** 只检查本实例实际尝试的附言；预检拒绝没有账本行也仍是未完成。 */
  incompleteNotes(): boolean {
    return [...this.requestedNotes].some((key) => {
      const status = this.ledger.get(key)?.status
      return status !== 'sent' && status !== 'confirmed'
    })
  }

  /** 有界等待已开始的交付；取消后晚到的上传不得再发消息，已发 POST 仍记录迟到回执。 */
  async settle(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DeliveryRecord[]> {
    this.closed = true
    if (this.invalidated) return this.receipts()
    if (options.signal?.aborted) {
      this.invalidated = true
      return this.receipts()
    }
    if (!this.pending.size) return this.receipts()
    const timeoutMs = options.timeoutMs ?? 60_000
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new DeliveryError('invalid', '交付等待时限无效')
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<'cancelled' | 'timeout'>((resolve) => {
      onAbort = () => {
        this.invalidated = true
        resolve('cancelled')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        this.invalidated = true
        resolve('timeout')
      }, timeoutMs)
    })
    const drained = async () => {
      while (this.pending.size && !this.invalidated) await Promise.allSettled([...this.pending])
      return 'complete' as const
    }
    try {
      const outcome = await Promise.race([drained(), interrupted])
      if (outcome === 'timeout' && (this.pendingPrimary.size || !this.primaryReceipts().some((r) => r.status === 'sent' || r.status === 'confirmed'))) {
        throw new DeliveryError('unknown', '交付等待超时，结果待核对；不会自动重发')
      }
      return this.receipts()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private assertCurrent(assertMaterial?: () => void): void {
    if (this.invalidated) throw new DeliveryError('denied', '工具交付已取消或等待超时，不能继续发送')
    this.deps.assertCurrent()
    this.assertMaterial(assertMaterial)
  }

  private assertMaterial(check?: () => void): void {
    const result: unknown = check?.()
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new DeliveryError('invalid', '材料投递校验必须同步完成')
    }
  }

  private isPrimaryKey(key: string): boolean {
    return /^question:\d+$/.test(key) || /^(?:dm|here):(?:file|message):[a-f0-9]{64}$/.test(key.slice(this.prefix.length))
  }

  private contextRef(privateMessage: boolean): string {
    return `${this.deps.contextRef}:tool:${privateMessage ? 'dm' : 'here'}`
  }

  private async perform(input: ToolDeliveryInput, privateMessage: boolean, assertMaterial?: () => void): Promise<ToolDeliveryResult> {
    const channel = privateMessage ? 'dm' : 'here'
    if (input.kind === 'message') {
      if (!input.text.trim()) throw new DeliveryError('invalid', '消息正文不能为空')
      const key = `${this.prefix}${channel}:message:${digest(input.text)}`
      return { delivery: await this.effect(key, { markdown: input.text }, privateMessage, undefined, undefined, assertMaterial) }
    }
    if (!input.name.trim() || input.name.includes('\0')) throw new DeliveryError('invalid', '文件名不能为空或含无效字符')
    const payload = { file: { name: input.name, sha256: digest(input.data), size: input.data.length } }
    const key = `${this.prefix}${channel}:file:${digest(JSON.stringify(payload.file))}`
    const delivery = await this.effect(key, payload, privateMessage, input.data, undefined, assertMaterial)
    // note 的变动只产生一条独立正文，不会重新上传 / 发送同一文件。
    if (!input.note?.trim()) return { delivery }
    const noteKey = `${key}:note:${digest(input.note)}`
    this.requestedNotes.add(noteKey)
    try {
      const note = await this.effect(noteKey, { markdown: input.note }, privateMessage, undefined, audienceIdentity(delivery.actorOpenId, delivery.audience), assertMaterial)
      return { delivery, note, noteStatus: note.status }
    } catch {
      // 发送文件已取得真实回执；附言另记状态，不把部分成功变成文件失败。
      const note = this.ledger.get(noteKey)
      return { delivery, ...(note ? { note } : {}), noteStatus: note?.status ?? 'not_sent' }
    }
  }

  private async effect(key: string, payload: DeliveryPayload, privateMessage: boolean, data?: Buffer, audienceSignature?: string, assertMaterial?: () => void): Promise<ToolDeliveryReceipt> {
    this.assertCurrent(assertMaterial)
    const existing = this.effects.get(key)
    if (existing) {
      const receipt = await existing
      this.assertMaterial(assertMaterial)
      return receipt
    }
    const operation = this.deliver(key, payload, privateMessage, data, audienceSignature, assertMaterial)
    this.effects.set(key, operation)
    if (this.isPrimaryKey(key)) this.pendingPrimary.add(operation)
    const finished = () => { this.effects.delete(key); this.pendingPrimary.delete(operation) }
    void operation.then(finished, finished)
    const receipt = await operation
    // The ledger has already recorded a real ACK. A stale caller may not use it, but cannot erase it.
    this.assertMaterial(assertMaterial)
    return receipt
  }

  private async deliver(key: string, payload: DeliveryPayload, privateMessage: boolean, data?: Buffer, audienceSignature?: string, assertMaterial?: () => void): Promise<ToolDeliveryReceipt> {
    let fileKey: string | undefined
    let contextCurrent: (() => boolean) | undefined
    const check = () => {
      if (contextCurrent) {
        if (!contextCurrent()) throw new DeliveryError('denied', '当前执行、授权或来源已变化')
      } else this.assertCurrent(assertMaterial)
    }
    const contextRef = this.contextRef(privateMessage)
    const service = new DeliveryService<DeliveryPayload>(this.db, {
      spaces: this.deps.spaces, policy: this.deps.policy, now: this.deps.now,
      resolveContext: async () => {
        this.assertCurrent(assertMaterial)
        const context = await this.deps.resolveContext(privateMessage)
        this.assertCurrent(assertMaterial)
        if (!context) return undefined
        // 固定收件人和原话题；await 上传期间的路由变化只能拒绝，不能改投别处。
        const a = context.audience
        const signature = audienceIdentity(context.actorOpenId, a)
        if (privateMessage && a.kind !== 'dm') throw new DeliveryError('denied', '私聊交付只能回本人')
        if (audienceSignature !== undefined && signature !== audienceSignature) throw new DeliveryError('denied', '工具交付的原受众或话题已变化')
        audienceSignature = signature
        const originalCurrent = context.isCurrent
        const isCurrent = () => {
          this.assertCurrent(assertMaterial)
          const current = originalCurrent?.() ?? true
          this.assertCurrent(assertMaterial)
          return current
        }
        contextCurrent = isCurrent
        return { ...context, isCurrent }
      },
      send: async ({ audience, payload: checked, mentionOpenIds }) => {
        check()
        if (this.isPrimaryKey(key)) this.deps.beforePrimarySend?.(key)
        check()
        if ('file' in checked) {
          if (!fileKey) throw new DeliveryError('invalid', '文件尚未上传')
          const remoteId = audience.kind === 'dm'
            ? await this.deps.feishu.sendFileToUser(audience.openId, fileKey)
            : audience.replyToMessageId
              ? await this.deps.feishu.replyFile(audience.replyToMessageId, fileKey, !audience.threadId)
              : await this.deps.feishu.sendFileToChat(audience.chatId, fileKey)
          return { remoteId }
        }
        const mentions = { mentionOpenIds }
        if (audience.kind === 'dm') return { remoteId: await this.deps.feishu.sendToUser(audience.openId, checked, mentions) }
        if (audience.replyToMessageId && 'markdown' in checked) {
          return { remoteId: (await this.deps.feishu.replyMarkdown(audience.replyToMessageId, checked.markdown, !audience.threadId, mentions)).messageId }
        }
        return { remoteId: await this.deps.feishu.sendToChat(audience.chatId, checked, mentions) }
      },
    })
    // 现有 planned / unknown 同样直接走账本裁决，不再上传或猜测重发。
    if (!this.ledger.get(key) && 'file' in payload) {
      await service.check(contextRef)
      check()
      if (!this.ledger.get(key)) fileKey = await this.deps.feishu.uploadFile(data!, payload.file.name)
      check()
    }
    return service.deliver({ key, contextRef, payload })
  }
}

function audienceIdentity(actorOpenId: string, audience: DeliveryAudience): string {
  return JSON.stringify([actorOpenId, audience.kind, audience.spaceId, ...(audience.kind === 'group'
    ? [audience.chatId, audience.replyToMessageId ?? null, audience.threadId ?? null] : [audience.openId])])
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
