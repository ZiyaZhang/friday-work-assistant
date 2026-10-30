import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryError, type DeliveryContext, deliveryPayloadDigest } from '../src/core/delivery.js'
import { Registry } from '../src/core/registry.js'
import { ToolDeliveryService } from '../src/core/tool-delivery.js'
import { FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const NOW = 1_800_000_000_000
const registries: Registry[] = []
afterEach(() => { vi.useRealTimers(); for (const r of registries.splice(0)) r.db.close() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

class Feishu extends FakeFeishu {
  beforeUpload?: () => Promise<void>
  afterFileSend?: () => Promise<void>
  beforeMessageSend?: () => Promise<void>
  override async uploadFile(data: string | Buffer, name: string): Promise<string> {
    const key = await super.uploadFile(data, name)
    await this.beforeUpload?.()
    return key
  }
  override async replyFile(messageId: string, fileKey: string, replyInThread = false): Promise<string> {
    const id = await super.replyFile(messageId, fileKey, replyInThread)
    await this.afterFileSend?.()
    return id
  }
  override async sendFileToUser(openId: string, fileKey: string): Promise<string> {
    const id = await super.sendFileToUser(openId, fileKey)
    await this.afterFileSend?.()
    return id
  }
  override async replyMarkdown(messageId: string, markdown: string, replyInThread = true) {
    await this.beforeMessageSend?.()
    return super.replyMarkdown(messageId, markdown, replyInThread)
  }
  override async sendToUser(openId: string, payload: Parameters<FakeFeishu['sendToUser']>[1]) {
    await this.beforeMessageSend?.()
    return super.sendToUser(openId, payload)
  }
}

function setup() {
  const registry = new Registry(':memory:')
  registries.push(registry)
  const sp = spaceDeps(registry.db)
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'chat_a', openId: 'alice' })
  const other = sp.spaces.ensure({ kind: 'group', chatId: 'chat_b', openId: 'bob' })
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat_dm', openId: 'alice' })
  const bobDm = sp.spaces.ensure({ kind: 'p2p', chatId: 'chat_bob_dm', openId: 'bob' })
  const state = { current: true, resolves: [] as boolean[], beforeResolve: undefined as undefined | (() => Promise<void>) }
  const local: DeliveryContext = {
    actorOpenId: 'alice', audience: { kind: 'group', spaceId: group.id, chatId: 'chat_a', replyToMessageId: 'root_a', threadId: 'thread_a' },
    sources: [{ ref: 'message_a', spaceId: group.id, chatId: 'chat_a' }], provenanceComplete: true, expiresAt: NOW + 60_000,
  }
  const personal: DeliveryContext = {
    ...local, audience: { kind: 'dm', spaceId: dm.id, openId: 'alice' },
    personalRead: { actorOpenId: 'alice', chatIds: ['chat_a', 'chat_b'], expiresAt: NOW + 60_000 },
  }
  const feishu = new Feishu()
  const deps = {
    ...sp, feishu, contextRef: 'run-1', keyPrefix: 'task-1:run-1', now: () => NOW,
    assertCurrent: () => { if (!state.current) throw new Error('synthetic run was cancelled') },
    resolveContext: async (privateMessage: boolean) => {
      state.resolves.push(privateMessage)
      await state.beforeResolve?.()
      return privateMessage ? personal : local
    },
  }
  const service = new ToolDeliveryService(registry.db, deps)
  return { registry, ...sp, group, other, dm, bobDm, feishu, deps, service, state, local, personal }
}

const file = () => ({ kind: 'file' as const, data: Buffer.from('synthetic-file-content'), name: 'synthetic.txt' })

describe('tool delivery receipts', () => {
  it('sends a host-registered question to the original topic once and includes it in settled receipts', async () => {
    const t = setup()
    const input = '出现问题前最后一次操作是什么？'
    const [a, b] = await Promise.all([t.service.sendQuestion(7, input), t.service.sendQuestion(7, input)])
    expect(a.delivery.key).toBe('question:7')
    expect(b.delivery.remoteId).toBe(a.delivery.remoteId)
    expect(t.feishu.sent).toMatchObject([{ kind: 'replyMarkdown', target: 'root_a', replyInThread: false }])
    expect(t.state.resolves).toEqual([false])
    expect(await t.service.settle()).toMatchObject([{ key: 'question:7', status: 'sent' }])
    expect(t.service.primaryReceipts()).toHaveLength(1)
    await expect(t.service.sendQuestion(8, '新问题')).rejects.toMatchObject({ code: 'denied' })
  })

  it('keeps a question with a lost acknowledgment unknown and does not send again', async () => {
    const t = setup()
    const send = t.feishu.replyMarkdown.bind(t.feishu)
    vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => { await send(...args); throw new Error('ACK lost') })
    await expect(t.service.sendQuestion(7, '具体操作是什么？')).rejects.toMatchObject({ code: 'unknown' })
    await expect(t.service.sendQuestion(7, '具体操作是什么？')).rejects.toMatchObject({ code: 'unknown' })
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.service.primaryReceipts()).toMatchObject([{ key: 'question:7', status: 'unknown' }])
  })

  it('cancels a question awaiting authorization without sending later', async () => {
    const t = setup(), entered = deferred(), release = deferred()
    t.state.beforeResolve = async () => { entered.resolve(); await release.promise }
    const sending = expect(t.service.sendQuestion(7, '具体操作是什么？')).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    await t.service.settle({ signal: AbortSignal.abort() })
    release.resolve()
    await sending
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
  })

  it('keeps a delivered file partial when only its note exceeds the settle deadline', async () => {
    vi.useFakeTimers()
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeMessageSend = async () => { entered.resolve(); await release.promise }
    const sending = t.service.send({ ...file(), note: '附言' })
    await entered.promise
    const settled = t.service.settle({ timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(await settled).toMatchObject([expect.objectContaining({ status: 'sent' }), expect.objectContaining({ status: 'planned' })])
    expect(t.service.primaryReceipts()).toMatchObject([{ status: 'sent' }])
    expect(t.service.incompleteNotes()).toBe(true)
    release.resolve()
    await sending
  })

  it('does not treat a second pending primary upload as only an incomplete note', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.service.send(file())
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const sending = t.service.send({ ...file(), name: 'second.txt' })
    const rejected = expect(sending).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    const settled = expect(t.service.settle({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'unknown' })
    await vi.advanceTimersByTimeAsync(20)
    await settled
    release.resolve()
    await rejected
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('records a real file message ACK with only content metadata and the original topic', async () => {
    const t = setup()
    const input = file()
    const { delivery } = await t.service.send(input)
    expect(delivery).toMatchObject({ status: 'sent', replayed: false, remoteId: t.feishu.sent[0]!.messageId })
    expect(t.feishu.sent).toMatchObject([{ kind: 'replyFile', target: 'root_a', replyInThread: false }])
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.state.resolves).toEqual([false, false])
    expect(delivery.payloadDigest).toBe(deliveryPayloadDigest({ file: {
      name: input.name, size: input.data.length, sha256: createHash('sha256').update(input.data).digest('hex'),
    } }))
    expect(JSON.stringify(t.registry.db.prepare('SELECT * FROM deliveries').all())).not.toContain(input.data.toString())
    expect(t.service.receipts()).toEqual([expect.objectContaining({ key: delivery.key, status: 'sent' })])
  })

  it('reuses a sent file across service recreation without uploading or sending it again', async () => {
    const t = setup()
    const original = await t.service.send(file())
    const recreated = new ToolDeliveryService(t.registry.db, t.deps)
    expect(await recreated.send(file())).toMatchObject({ delivery: { key: original.delivery.key, replayed: true, status: 'sent' } })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('shares a concurrent file upload while independently delivering distinct notes once', async () => {
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const a = t.service.send({ ...file(), note: '第一条说明' })
    await entered.promise
    const b = t.service.send({ ...file(), note: '补充说明' })
    release.resolve()
    await Promise.all([a, b])
    await t.service.send({ ...file(), note: '补充说明' })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent.map((s) => s.kind)).toEqual(['replyFile', 'replyMarkdown', 'replyMarkdown'])
    expect(t.service.receipts()).toHaveLength(3)
  })

  it('separates different bytes and file names rather than deduplicating only by path', async () => {
    const t = setup()
    await t.service.send(file())
    await t.service.send({ ...file(), data: Buffer.from('changed-bytes') })
    await t.service.send({ ...file(), name: 'renamed.txt' })
    expect(new Set(t.service.receipts().map((r) => r.key)).size).toBe(3)
    expect(t.feishu.uploads).toHaveLength(3)
    expect(t.feishu.sent).toHaveLength(3)
  })

  it('snapshots caller bytes before any authorization await', async () => {
    const t = setup()
    const input = file(), expected = Buffer.from(input.data)
    const sending = t.service.send(input)
    input.data.fill(0)
    await sending
    expect(t.feishu.uploads[0]!.path).toEqual(expected)
  })

  it('forces messages to the requester DM and uses content-derived idempotency', async () => {
    const t = setup()
    const a = await t.service.send({ kind: 'message', text: '合成私聊结果' })
    const b = await t.service.send({ kind: 'message', text: '合成私聊结果' }, false)
    expect(a.delivery).toMatchObject({ status: 'sent', audience: { kind: 'dm', openId: 'alice' } })
    expect(b.delivery).toMatchObject({ replayed: true, key: a.delivery.key })
    expect(t.state.resolves.every(Boolean)).toBe(true)
    expect(t.feishu.sent).toMatchObject([{ kind: 'sendToUser', target: 'alice', payload: { markdown: '合成私聊结果' } }])
  })

  it('keeps a sent file receipt if its separate note fails, and never resends either effect blindly', async () => {
    const t = setup()
    t.feishu.beforeMessageSend = async () => { throw new Error('synthetic note timeout') }
    expect(await t.service.send({ ...file(), note: '合成说明' })).toMatchObject({
      delivery: { status: 'sent', remoteId: t.feishu.sent[0]?.messageId }, note: { status: 'unknown', remoteId: null }, noteStatus: 'unknown',
    })
    expect(t.service.receipts().map((r) => r.status).sort()).toEqual(['sent', 'unknown'])
    expect(t.service.primaryReceipts()).toEqual([expect.objectContaining({ status: 'sent', remoteId: t.feishu.sent[0]!.messageId })])
    expect(t.service.incompleteNotes()).toBe(true)
    expect(await t.service.send({ ...file(), note: '合成说明' })).toMatchObject({ delivery: { status: 'sent', replayed: true }, noteStatus: 'unknown' })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
    expect((await t.service.settle()).filter((r) => r.status === 'sent')).toHaveLength(1)
  })

  it('retains unknown after a file POST loses its ACK and forbids another upload or POST', async () => {
    const t = setup()
    t.feishu.afterFileSend = async () => { throw new Error('synthetic lost ACK') }
    await expect(t.service.send(file())).rejects.toMatchObject({ code: 'unknown' })
    expect(t.service.receipts()).toEqual([expect.objectContaining({ status: 'unknown', remoteId: null })])
    const reopened = new ToolDeliveryService(t.registry.db, t.deps)
    await expect(reopened.send(file())).rejects.toMatchObject({ code: 'unknown' })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('exposes planned while ACK is pending and settle waits for the platform result', async () => {
    const t = setup()
    const accepted = deferred(), release = deferred()
    t.feishu.afterFileSend = async () => { accepted.resolve(); await release.promise }
    const sending = t.service.send(file())
    await accepted.promise
    expect(t.service.receipts()).toEqual([expect.objectContaining({ status: 'planned', remoteId: null })])
    const second = new ToolDeliveryService(t.registry.db, t.deps)
    await expect(second.send(file())).rejects.toMatchObject({ code: 'unknown' })
    let settled = false
    const drain = t.service.settle().then((rows) => { settled = true; return rows })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await sending
    expect(await drain).toEqual([expect.objectContaining({ status: 'sent', remoteId: t.feishu.sent[0]!.messageId })])
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(1)
  })

  it('does not count an uploaded file as a delivery or resolve settle before upload ends', async () => {
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise; throw new Error('synthetic upload failed') }
    const sending = t.service.send(file())
    const rejected = expect(sending).rejects.toThrow('synthetic upload failed')
    await entered.promise
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.service.receipts()).toEqual([])
    expect(t.feishu.sent).toEqual([])
    let settled = false
    const drain = t.service.settle().then((rows) => { settled = true; return rows })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await rejected
    expect(await drain).toEqual([])
  })

  it('closes the task to new sends while allowing the in-flight file and its note to finish', async () => {
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const sending = t.service.send({ ...file(), note: '跟随原文件的说明' })
    await entered.promise
    const drain = t.service.settle()
    await expect(t.service.send({ kind: 'message', text: '收尾之后不能新发' })).rejects.toMatchObject({ code: 'denied' })
    release.resolve()
    await sending
    expect(await drain).toHaveLength(2)
    expect(t.feishu.sent.map((s) => s.kind)).toEqual(['replyFile', 'replyMarkdown'])
  })

  it('cancels settle without waiting for a hanging upload and never POSTs when that upload returns', async () => {
    const t = setup()
    const entered = deferred(), release = deferred(), abort = new AbortController()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const sending = t.service.send({ ...file(), note: '不能晚发的说明' })
    const cancelled = expect(sending).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    const settling = t.service.settle({ signal: abort.signal, timeoutMs: 60_000 })
    abort.abort()
    expect(await settling).toEqual([])
    // 取消即返回，二次 catch 收尾也不再等待挂起的上传。
    expect(await t.service.settle()).toEqual([])
    expect(t.feishu.sent).toEqual([])
    release.resolve()
    await cancelled
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
  })

  it('returns planned immediately on cancellation, records a late POST ACK, and does not start its note', async () => {
    const t = setup()
    const accepted = deferred(), release = deferred(), abort = new AbortController()
    t.feishu.afterFileSend = async () => { accepted.resolve(); await release.promise }
    const sending = t.service.send({ ...file(), note: '已取消后不能再发的说明' })
    await accepted.promise
    const settling = t.service.settle({ signal: abort.signal })
    abort.abort()
    expect(await settling).toEqual([expect.objectContaining({ status: 'planned', remoteId: null })])
    expect(await t.service.settle()).toEqual([expect.objectContaining({ status: 'planned' })])
    release.resolve()
    expect(await sending).toMatchObject({ delivery: { status: 'sent', remoteId: t.feishu.sent[0]!.messageId }, noteStatus: 'not_sent' })
    expect(t.service.primaryReceipts()).toEqual([expect.objectContaining({ status: 'sent', remoteId: t.feishu.sent[0]!.messageId })])
    expect(t.feishu.sent).toHaveLength(1)
    expect(t.service.incompleteNotes()).toBe(true)
  })

  it('bounds hanging upload wait by its deadline and does not permit a late upload to trigger a POST', async () => {
    vi.useFakeTimers()
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const sending = t.service.send(file())
    const cancelled = expect(sending).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    const settling = t.service.settle({ timeoutMs: 25 })
    const timeout = expect(settling).rejects.toMatchObject({ code: 'unknown' })
    await vi.advanceTimersByTimeAsync(25)
    await timeout
    expect(await t.service.settle()).toEqual([])
    await expect(t.service.send(file())).rejects.toMatchObject({ code: 'denied' })
    release.resolve()
    await cancelled
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('filters receipts by the exact host task context and prefix, including after recreation', async () => {
    const t = setup()
    await t.service.send(file())
    const otherRun = new ToolDeliveryService(t.registry.db, { ...t.deps, contextRef: 'run-2' })
    const prefixNeighbour = new ToolDeliveryService(t.registry.db, { ...t.deps, keyPrefix: 'task-1:run-10' })
    expect(otherRun.primaryReceipts()).toEqual([])
    expect(prefixNeighbour.primaryReceipts()).toEqual([])
    expect(new ToolDeliveryService(t.registry.db, t.deps).primaryReceipts()).toHaveLength(1)
  })
})

describe('tool delivery audience and fresh authority', () => {
  it('allows current cross-group reading evidence back to the same requester, but not into another group', async () => {
    const t = setup()
    const source = { ref: 'trusted-other-group-message', spaceId: t.other.id, chatId: 'chat_b' }
    t.personal.sources = [source]
    t.local.sources = [source]
    await expect(t.service.send(file())).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.uploads).toHaveLength(0)
    expect(await t.service.send(file(), true)).toMatchObject({ delivery: { status: 'sent', audience: { kind: 'dm', openId: 'alice' } } })
    expect(t.feishu.sent).toMatchObject([{ kind: 'sendFileToUser', target: 'alice' }])
  })

  it.each(['other-person', 'group', 'expired-reading-proof'] as const)('denies private delivery for %s before upload or send', async (kind) => {
    const t = setup()
    if (kind === 'other-person') t.personal.audience = { kind: 'dm', spaceId: t.bobDm.id, openId: 'bob' }
    if (kind === 'group') t.personal.audience = t.local.audience
    if (kind === 'expired-reading-proof') t.personal.personalRead!.expiresAt = NOW
    await expect(t.service.send(file(), true)).rejects.toMatchObject({ code: 'denied' })
    await expect(t.service.send({ kind: 'message', text: '合成结果' })).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.uploads).toEqual([])
    expect(t.feishu.sent).toEqual([])
  })

  it.each(['cancelled-run', 'archived-source', 'expired-personal-read', 'changed-audience', 'changed-thread'] as const)('does not send when %s changes during upload', async (kind) => {
    const t = setup()
    const entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const privateMessage = kind === 'expired-personal-read'
    const sending = t.service.send(file(), privateMessage)
    const rejection = expect(sending).rejects.toThrow()
    await entered.promise
    if (kind === 'cancelled-run') t.state.current = false
    if (kind === 'archived-source') t.spaces.archive(t.group.id)
    if (kind === 'expired-personal-read') t.personal.personalRead!.expiresAt = NOW
    if (kind === 'changed-audience') {
      t.spaces.addMember(t.other.id, 'alice', 'owner')
      t.local.audience = { kind: 'group', spaceId: t.other.id, chatId: 'chat_b', replyToMessageId: 'root_b' }
      t.local.sources = [{ ref: 'message_b', spaceId: t.other.id, chatId: 'chat_b' }]
    }
    if (kind === 'changed-thread') t.local.audience = { ...t.local.audience, kind: 'group', chatId: 'chat_a', replyToMessageId: 'different_root', threadId: 'different_thread' }
    release.resolve()
    await rejection
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
  })

  it('rechecks source additions after upload and refuses newly crossed provenance without a grant', async () => {
    const t = setup()
    t.feishu.beforeUpload = async () => {
      t.local.sources = [...t.local.sources, { ref: 'new-cross-source', spaceId: t.other.id, chatId: 'chat_b' }]
    }
    await expect(t.service.send(file())).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toHaveLength(0)
    expect(t.service.receipts()).toEqual([])
  })

  it('checks cancellation after asynchronous fresh context resolution, before any platform POST', async () => {
    const t = setup()
    t.state.beforeResolve = async () => { t.state.current = false }
    await expect(t.service.send({ kind: 'message', text: '不应发出的合成正文' })).rejects.toThrow('cancelled')
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
  })

  it('uses the trusted group audience for a top-level file without a reply anchor', async () => {
    const t = setup()
    t.local.audience = { kind: 'group', spaceId: t.group.id, chatId: 'chat_a' }
    expect(await t.service.send(file())).toMatchObject({ delivery: { status: 'sent', audience: { kind: 'group', chatId: 'chat_a' } } })
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toMatchObject([{ kind: 'sendFileToChat', target: 'chat_a' }])
  })

  it('does not redirect a file note to a new otherwise valid topic after the file was sent', async () => {
    const t = setup()
    t.feishu.afterFileSend = async () => {
      t.local.audience = { kind: 'group', spaceId: t.group.id, chatId: 'chat_a', replyToMessageId: 'other_root', threadId: 'other_thread' }
    }
    const result = await t.service.send({ ...file(), note: '说明' })
    expect(result).toMatchObject({ delivery: { status: 'sent' }, noteStatus: 'not_sent' })
    expect(result.note).toBeUndefined()
    expect(t.feishu.sent).toMatchObject([{ kind: 'replyFile', target: 'root_a' }])
    expect(t.service.receipts()).toEqual([expect.objectContaining({ status: 'sent' })])
    expect(t.service.incompleteNotes()).toBe(true)
  })

  it('starts a thread for an original group message and preserves the same routing for its note', async () => {
    const t = setup()
    t.local.audience = { kind: 'group', spaceId: t.group.id, chatId: 'chat_a', replyToMessageId: 'root_a' }
    const result = await t.service.send({ ...file(), note: '说明' })
    expect(result).toMatchObject({ delivery: { status: 'sent' }, note: { status: 'sent' }, noteStatus: 'sent' })
    expect(t.service.primaryReceipts()).toHaveLength(1)
    expect(t.service.incompleteNotes()).toBe(false)
    expect(t.feishu.sent).toMatchObject([
      { kind: 'replyFile', target: 'root_a', replyInThread: true },
      { kind: 'replyMarkdown', target: 'root_a', replyInThread: true },
    ])
  })
})

describe('per-call material guards on real tool delivery', () => {
  it.each(['stopped', 'revoked', 'new-version'] as const)('refuses %s during upload before planning or posting', async reason => {
    const t = setup(), entered = deferred(), release = deferred()
    let current = true
    const guard = () => { if (!current) throw new DeliveryError('denied', `material ${reason}`) }
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const pending = t.service.send(file(), false, guard)
    const rejected = expect(pending).rejects.toThrow(`material ${reason}`)
    await entered.promise; current = false; release.resolve(); await rejected
    expect(t.feishu.uploads).toHaveLength(1)
    expect(t.feishu.sent).toEqual([]); expect(t.service.receipts()).toEqual([])
  })

  it('checks material before the first upload and rejects an asynchronous assertion', async () => {
    const t = setup()
    await expect(t.service.send(file(), false, () => { throw new DeliveryError('denied', 'material unavailable') })).rejects.toThrow('material unavailable')
    await expect(t.service.send(file(), false, async () => undefined)).rejects.toMatchObject({ code: 'invalid' })
    expect(t.feishu.uploads).toEqual([]); expect(t.feishu.sent).toEqual([]); expect(t.service.receipts()).toEqual([])
  })

  it('checks each invocation after context resolution before any upload or message admission', async () => {
    const t = setup(), entered = deferred(), release = deferred()
    let current = true
    t.state.beforeResolve = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.service.send({ kind: 'message', text: 'material-derived' }, false,
      () => { if (!current) throw new DeliveryError('denied', 'material changed') })).rejects.toThrow('material changed')
    await entered.promise; current = false; release.resolve(); await pending
    expect(t.feishu.uploads).toEqual([]); expect(t.feishu.sent).toEqual([]); expect(t.service.receipts()).toEqual([])
  })

  it('preserves the material guard across context promise continuations through synchronous ledger admission', async () => {
    const t = setup()
    let current = true, contextChecks = 0
    // Return a valid context, then revoke after its own guard runs. The material guard must still run at admission.
    t.personal.isCurrent = () => {
      contextChecks++
      current = false
      return true
    }
    await expect(t.service.send({ kind: 'message', text: 'must not be planned' }, false,
      () => { if (!current) throw new DeliveryError('denied', 'material changed at admission') })).rejects.toThrow()
    expect(contextChecks).toBeGreaterThan(0)
    expect(t.feishu.sent).toEqual([])
    expect(t.service.receipts()).toEqual([])
  })

  it('rechecks immediately before POST after the synchronous primary hook', async () => {
    const t = setup()
    let current = true
    const service = new ToolDeliveryService(t.registry.db, { ...t.deps, beforePrimarySend: () => { current = false } })
    await expect(service.send(file(), false, () => { if (!current) throw new DeliveryError('denied', 'material changed at POST') })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.feishu.sent).toEqual([])
    // Admission already committed before the host hook; the existing conservative ledger semantics remain intact.
    expect(service.receipts()).toMatchObject([{ status: 'unknown', remoteId: null }])
  })

  it('does not let a denied second caller reuse a pending upload or publish its note', async () => {
    const t = setup(), entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const first = t.service.send(file(), false, () => undefined)
    await entered.promise
    await expect(t.service.send({ ...file(), note: 'forbidden note' }, false,
      () => { throw new DeliveryError('denied', 'second material revoked') })).rejects.toThrow('second material revoked')
    release.resolve(); const sent = await first
    expect(sent.delivery.status).toBe('sent')
    expect(t.feishu.uploads).toHaveLength(1); expect(t.feishu.sent.map(x => x.kind)).toEqual(['replyFile'])
  })

  it('rechecks a sharing caller after awaiting the same POST without invalidating the authorized sender receipt', async () => {
    const t = setup(), entered = deferred(), release = deferred()
    t.feishu.afterFileSend = async () => { entered.resolve(); await release.promise }
    const first = t.service.send(file(), false, () => undefined)
    await entered.promise
    let secondCurrent = true
    const second = t.service.send({ ...file(), note: 'late note' }, false,
      () => { if (!secondCurrent) throw new DeliveryError('denied', 'sharing caller revoked') })
    const rejected = expect(second).rejects.toThrow('sharing caller revoked')
    secondCurrent = false; release.resolve()
    expect((await first).delivery.status).toBe('sent'); await rejected
    expect(t.feishu.sent.map(x => x.kind)).toEqual(['replyFile'])
    expect(t.service.primaryReceipts()).toMatchObject([{ status: 'sent', remoteId: t.feishu.sent[0]!.messageId }])
  })

  it('records a late successful ACK before rejecting an invalid material return and never sends its note', async () => {
    const t = setup(), entered = deferred(), release = deferred()
    let current = true
    t.feishu.afterFileSend = async () => { entered.resolve(); await release.promise }
    const pending = t.service.send({ ...file(), note: 'do not send late' }, false,
      () => { if (!current) throw new DeliveryError('denied', 'late material revoked') })
    const rejected = expect(pending).rejects.toThrow('late material revoked')
    await entered.promise; current = false; release.resolve(); await rejected
    expect(t.service.primaryReceipts()).toMatchObject([{ status: 'sent', remoteId: t.feishu.sent[0]!.messageId }])
    expect(t.feishu.sent.map(x => x.kind)).toEqual(['replyFile'])
    expect((await t.service.send(file(), false, () => undefined)).delivery).toMatchObject({ status: 'sent', replayed: true })
    expect(t.feishu.uploads).toHaveLength(1); expect(t.feishu.sent).toHaveLength(1)
  })

  it('keeps ACK loss unknown even if material is revoked during POST, and a later valid call cannot upload or send again', async () => {
    const t = setup()
    let current = true
    t.feishu.afterFileSend = async () => { current = false; throw new Error('lost ACK') }
    await expect(t.service.send(file(), false, () => { if (!current) throw new DeliveryError('denied', 'revoked') })).rejects.toMatchObject({ code: 'unknown' })
    expect(t.service.primaryReceipts()).toMatchObject([{ status: 'unknown', remoteId: null }])
    const reopened = new ToolDeliveryService(t.registry.db, t.deps)
    await expect(reopened.send(file(), false, () => undefined)).rejects.toMatchObject({ code: 'unknown' })
    expect(t.feishu.uploads).toHaveLength(1); expect(t.feishu.sent).toHaveLength(1)
  })

  it('checks the final caller even when a note failure is converted to a partial primary receipt', async () => {
    const t = setup()
    let current = true
    t.feishu.beforeMessageSend = async () => { current = false; throw new Error('note ACK unavailable') }
    await expect(t.service.send({ ...file(), note: 'note' }, false,
      () => { if (!current) throw new DeliveryError('denied', 'caller no longer current') })).rejects.toThrow('caller no longer current')
    expect(t.service.primaryReceipts()).toMatchObject([{ status: 'sent', remoteId: t.feishu.sent[0]!.messageId }])
    expect(t.service.receipts().map(row => row.status).sort()).toEqual(['sent', 'unknown'])
    expect(t.feishu.sent.map(x => x.kind)).toEqual(['replyFile'])
  })
})
