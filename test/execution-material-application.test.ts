import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication, type MaterialRun } from '../src/core/execution-material-application.js'
import { ToolDeliveryService } from '../src/core/tool-delivery.js'
import { FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class Feishu extends FakeFeishu {
  beforeUpload?: () => Promise<void>
  afterFileSend?: () => Promise<void>
  beforeNote?: () => Promise<void>
  override async uploadFile(data: string | Buffer, name: string) { const key = await super.uploadFile(data, name); await this.beforeUpload?.(); return key }
  override async replyFile(messageId: string, fileKey: string, replyInThread = false) {
    const id = await super.replyFile(messageId, fileKey, replyInThread); await this.afterFileSend?.(); return id
  }
  override async replyMarkdown(messageId: string, markdown: string, replyInThread = true) {
    await this.beforeNote?.(); return super.replyMarkdown(messageId, markdown, replyInThread)
  }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-material-application-')), registry = new Registry(join(home, 'db'))
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const sp = spaceDeps(registry.db), group = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const files = new ExecutionMaterials(registry.db, join(home, 'content'))
  const state = { current: true, expired: false, denied: new Set<string>(),
    beforeAuthorize: undefined as undefined | ((source: MaterialProvenance) => Promise<void>),
    beforeConsume: undefined as undefined | (() => void) }
  const ctx: MaterialContext = { runId: 'run-a', sessionKey: 'session-a', spaceId: group.id, generation: 'generation-a',
    assertCurrent() { if (!state.current) throw new Error(`private-stop-${home}`) } }
  files.openGeneration(ctx)
  let snapshot: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: group.id, chatId: 'chat-a',
    memoryScopes: [], chats: [], external: [], repositories: [], personalMemoryComplete: true }, memoryRefs: [] }
  const base = structuredClone(snapshot), consumed: MaterialProvenance[] = [], authorized: MaterialProvenance[] = []
  const feishu = new Feishu(), deliveries: ToolDeliveryService[] = []
  const run: MaterialRun = {
    context: ctx, snapshot: () => structuredClone(snapshot),
    async authorize(provenance) {
      authorized.push(structuredClone(provenance)); await state.beforeAuthorize?.(provenance)
      return { assertCurrent() { if (state.expired || provenance.sources.repositories.some(repo => state.denied.has(repo))) throw new Error('private-source-token-or-url') } }
    },
    consume(provenance) {
      state.beforeConsume?.(); consumed.push(structuredClone(provenance))
      const union = <T>(a: T[], b: T[]) => [...new Map([...a, ...b].map(item => [JSON.stringify(item), item])).values()]
      snapshot = { sources: { ...snapshot.sources, memoryScopes: union(snapshot.sources.memoryScopes, provenance.sources.memoryScopes),
        chats: union(snapshot.sources.chats, provenance.sources.chats), external: union(snapshot.sources.external, provenance.sources.external),
        repositories: union(snapshot.sources.repositories, provenance.sources.repositories),
        messageSources: union(snapshot.sources.messageSources ?? [], provenance.sources.messageSources ?? []),
        personalMemoryComplete: snapshot.sources.personalMemoryComplete === true && provenance.sources.personalMemoryComplete === true },
      memoryRefs: union(snapshot.memoryRefs, provenance.memoryRefs) }
    },
    async deliver(file, assertCurrent) {
      const service = new ToolDeliveryService(registry.db, { ...sp, feishu, contextRef: 'task:7:session:a', keyPrefix: 'task:7',
        assertCurrent, now: () => 1000, resolveContext: async () => ({ actorOpenId: 'alice', provenanceComplete: true,
          sources: [{ ref: 'original-message', spaceId: group.id, chatId: 'chat-a' }], expiresAt: 99999999,
          audience: { kind: 'group', spaceId: group.id, chatId: 'chat-a', replyToMessageId: 'original' } }) })
      deliveries.push(service)
      return service.send({ kind: 'file', ...file })
    },
  }
  const app = new ExecutionMaterialApplication({ files, resolveRun: () => run })
  let serial = 0
  const file = (text = 'one\nneedle\nlast', source?: string) => {
    const provenance = structuredClone(base)
    if (source) provenance.sources.repositories.push(source)
    return files.register(ctx, { operationKey: `input-${++serial}`, name: `private-${serial}.txt`, data: Buffer.from(text), provenance })
  }
  return { home, registry, files, state, ctx, run, app, file, base, consumed, authorized, feishu, deliveries,
    get snapshot() { return snapshot }, set snapshot(next: MaterialProvenance) { snapshot = next } }
}
const handle = (file: { fileId: string; digest: string }) => ({ fileId: file.fileId, expectedDigest: file.digest })
const projection = (file: { fileId: string; digest: string; version: number; name: string; size: number }) => ({
  fileId: file.fileId, digest: file.digest, version: file.version, name: file.name, size: file.size })

describe('execution material application using real storage and Delivery, synthetic authorization/Feishu', () => {
  it('authorizes and consumes before showing names, text, or literal hits; public responses contain no host provenance', async () => {
    const t = fixture(), a = t.file('first\nneedle\nlast', 'test-org/private')
    expect(await t.app.list('run-a')).toEqual({ files: [projection(a)], limit: 100, truncated: false })
    const read = await t.app.read('run-a', { ...handle(a), startLine: 2, endLine: 2 })
    expect(read).toMatchObject({ ...projection(a), text: 'needle\n', totalLines: 3, truncated: true })
    expect(await t.app.search('run-a', { files: [handle(a)], query: 'needle' })).toMatchObject({ total: 1,
      matches: [{ fileId: a.fileId, line: 2, column: 1, text: 'needle\n' }] })
    expect(t.authorized).toHaveLength(3); expect(t.consumed).toHaveLength(3)
    expect(t.snapshot.sources.repositories).toEqual(['test-org/private'])
    expect(JSON.stringify(read)).not.toMatch(/test-org|provenance|originRun|sessionKey|spaceId/)
    expect(JSON.stringify(read)).not.toContain(t.home)
  })

  it('a partially unauthorized list rejects rather than returning names or claiming the list is empty', async () => {
    const t = fixture(); t.file('allowed'); t.file('forbidden', 'private/denied'); t.state.denied.add('private/denied')
    await expect(t.app.list('run-a')).rejects.toMatchObject({ code: 'denied', message: '本次文件操作未完成：denied' })
    expect(t.feishu.sent).toEqual([])
  })

  it.each(['read', 'search', 'send', 'edit'] as const)('rejects %s when the same digest acquires a newer provenance version during authorization', async method => {
    const t = fixture(), a = t.file('A'), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = method === 'read' ? t.app.read('run-a', handle(a)) : method === 'search'
      ? t.app.search('run-a', { files: [handle(a)], query: 'A' }) : method === 'send'
        ? t.app.send('run-a', handle(a)) : t.app.edit('run-a', { ...handle(a), edits: [{ oldText: 'A', newText: 'C' }] }, 'edit-after-auth')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'version_conflict' })
    await entered.promise
    const provenance = structuredClone(a.provenance); provenance.sources.repositories.push('private/new-source')
    t.files.edit(t.ctx, { ...handle(a), expectedVersion: a.version, operationKey: 'same-bytes', edits: [{ oldText: 'A', newText: 'A' }], provenance })
    release.resolve(); await rejected
    expect(t.deliveries).toEqual([])
    expect(t.files.list(t.ctx).items[0]?.version).toBe(2)
  })

  it.each(['stop', 'expired', 'generation'] as const)('rejects authorization completion after %s without exposing bytes or sending', async reason => {
    const t = fixture(), a = t.file(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.send('run-a', handle(a))).rejects.toMatchObject({ code: reason === 'generation' ? 'generation_invalid' : 'denied' })
    await entered.promise
    if (reason === 'stop') t.state.current = false
    if (reason === 'expired') t.state.expired = true
    if (reason === 'generation') t.files.invalidateGeneration(t.ctx, 'memory_forgotten')
    release.resolve(); await pending
    expect(t.consumed).toEqual([]); expect(t.feishu.sent).toEqual([])
  })

  it('writes the entire current context, replays the original receipt despite later inputs, and rejects changed text under the same key', async () => {
    const t = fixture(); t.snapshot.sources.repositories.push('private/a'); t.snapshot.memoryRefs.push({ id: 1, revision: 3 })
    // The host snapshot includes an explicit empty source list, matching its idempotent consume.
    t.snapshot.sources.messageSources = []
    const a = await t.app.write('run-a', { name: 'output.txt', text: 'first' }, 'write-once')
    expect(t.files.metadata(t.ctx, a.fileId, a.digest).provenance).toEqual(t.snapshot)
    t.snapshot.sources.repositories.push('private/later')
    expect(await t.app.write('run-a', { name: 'output.txt', text: 'first' }, 'write-once')).toEqual(a)
    expect(t.authorized.at(-1)?.sources.repositories).toEqual(['private/a'])
    await expect(t.app.write('run-a', { name: 'output.txt', text: 'other' }, 'write-once')).rejects.toMatchObject({ code: 'operation_conflict' })
    expect(t.files.list(t.ctx).total).toBe(1)
    t.state.denied.add('private/a')
    await expect(t.app.write('run-a', { name: 'output.txt', text: 'first' }, 'write-once')).rejects.toMatchObject({ code: 'denied' })
  })

  it('rejects new writes when an additional source arrives during authorization, leaving no artifact row', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.write('run-a', { name: 'new.txt', text: 'output' }, 'write')).rejects.toMatchObject({ code: 'context_changed' })
    await entered.promise; t.snapshot.sources.repositories.push('private/late'); release.resolve(); await pending
    expect(t.files.list(t.ctx).total).toBe(0)
  })

  it('edits inherit the consumed file plus all prior context, and replay returns its original version without rolling back later edits', async () => {
    const t = fixture(), a = t.file('A', 'private/file')
    t.snapshot.sources.repositories.push('private/prior'); t.snapshot.memoryRefs.push({ id: 2, revision: 1 })
    const input = { ...handle(a), edits: [{ oldText: 'A', newText: 'B' }] }
    const b = await t.app.edit('run-a', input, 'edit-once')
    expect(t.files.metadata(t.ctx, b.fileId, b.digest).provenance.sources.repositories).toEqual(['private/prior', 'private/file'])
    const c = await t.app.edit('run-a', { ...handle(b), edits: [{ oldText: 'B', newText: 'C' }] }, 'edit-next')
    t.snapshot.sources.repositories.push('private/later')
    expect(await t.app.edit('run-a', input, 'edit-once')).toEqual(b)
    expect(t.files.read(t.ctx, { ...handle(c), expectedVersion: c.version }).data.toString()).toBe('C')
    await expect(t.app.edit('run-a', { ...input, edits: [{ oldText: 'A', newText: 'D' }] }, 'edit-once'))
      .rejects.toMatchObject({ code: 'operation_conflict' })
    expect(t.files.list(t.ctx).items[0]?.version).toBe(3)
  })

  it('rejects snapshot growth during the second edit authorization without publishing a new version', async () => {
    const t = fixture(), a = t.file('A', 'private/file'), entered = deferred(), release = deferred(); let calls = 0
    t.state.beforeAuthorize = async () => { if (++calls === 2) { entered.resolve(); await release.promise } }
    const pending = expect(t.app.edit('run-a', { ...handle(a), edits: [{ oldText: 'A', newText: 'B' }] }, 'edit')).rejects.toMatchObject({ code: 'context_changed' })
    await entered.promise; t.snapshot.sources.repositories.push('private/new'); release.resolve(); await pending
    expect(t.files.list(t.ctx).items[0]?.version).toBe(1)
  })

  it('captures host download bytes/source and model inputs before awaiting, without accepting a changed import provenance on replay', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    const input = { name: 'upload.txt', data: Buffer.from('original'), provenance: structuredClone(t.base) }
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = t.app.register('run-a', input, 'download'); await entered.promise
    input.data.fill(0); input.name = 'mutated.txt'; input.provenance.sources.repositories.push('private/forged')
    release.resolve(); const file = await pending
    expect(file.name).toBe('upload.txt')
    expect(t.files.read(t.ctx, handle(file)).data.toString()).toBe('original')
    await expect(t.app.register('run-a', { name: 'upload.txt', data: Buffer.from('original'), provenance: input.provenance }, 'download'))
      .rejects.toMatchObject({ code: 'operation_conflict' })
  })

  it('checks after consumption and sanitizes internal authorization errors instead of returning material details', async () => {
    const t = fixture(), a = t.file()
    t.state.beforeConsume = () => { t.state.current = false }
    await expect(t.app.read('run-a', handle(a))).rejects.toMatchObject({ code: 'denied', message: '本次文件操作未完成：denied' })
    await expect(t.app.read('wrong-run', handle(a))).rejects.toMatchObject({ code: 'denied' })
    expect(t.deliveries).toEqual([])
  })

  it.each(['authorization', 'consumption'])('host import guards reject invalidation during %s before publishing any metadata', async phase => {
    const t = fixture(), entered = deferred(), release = deferred(); let allowed = true
    const guard = () => { if (!allowed) throw new Error('private origin Task no longer current') }
    if (phase === 'authorization') t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    else t.state.beforeConsume = () => { allowed = false }
    const pending = expect(t.app.register('run-a', { name: 'input.txt', data: Buffer.from('input'), provenance: t.base }, 'guarded-import', guard))
      .rejects.toMatchObject({ code: 'denied' })
    if (phase === 'authorization') { await entered.promise; allowed = false; release.resolve() }
    await pending
    expect(t.files.list(t.ctx).total).toBe(0)
  })

  it('uses actual Delivery sent receipts and sends the same file once; note failure stays partial', async () => {
    const t = fixture(), a = t.file('actual bytes')
    t.feishu.beforeNote = async () => { throw new Error('synthetic note ACK unknown') }
    const first = await t.app.send('run-a', { ...handle(a), note: 'note' })
    expect(first).toMatchObject({ ...projection(a), status: 'sent', messageId: expect.any(String), noteStatus: 'unknown' })
    const second = await t.app.send('run-a', handle(a))
    expect(second).toMatchObject({ status: 'sent', replayed: true, messageId: first.messageId })
    expect(t.feishu.sent.filter(item => item.kind === 'replyFile')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM deliveries ORDER BY created_at,delivery_key').all().map(row => row.status).sort())
      .toEqual(['sent', 'unknown'])
    expect(JSON.stringify(first)).not.toMatch(/contextRef|actorOpenId|sourceRefs|provenance/)
  })

  it.each(['stop', 'file-version', 'lease'] as const)('guards a real pending upload through %s and never posts the file', async reason => {
    const t = fixture(), a = t.file('A'), entered = deferred(), release = deferred()
    t.feishu.beforeUpload = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.send('run-a', handle(a))).rejects.toMatchObject({ code: reason === 'file-version' ? 'version_conflict' : 'denied' })
    await entered.promise
    if (reason === 'stop') t.state.current = false
    if (reason === 'lease') t.state.expired = true
    if (reason === 'file-version') t.files.edit(t.ctx, { ...handle(a), operationKey: 'during-upload', edits: [{ oldText: 'A', newText: 'B' }], provenance: a.provenance })
    release.resolve(); await pending
    expect(t.feishu.sent).toEqual([])
    expect(t.registry.db.prepare('SELECT * FROM deliveries').all()).toEqual([])
  })

  it('keeps a real accepted POST with lost ACK unknown and refuses to resend under the same intent', async () => {
    const t = fixture(), a = t.file()
    t.feishu.afterFileSend = async () => { throw new Error('synthetic lost ACK') }
    await expect(t.app.send('run-a', handle(a))).rejects.toMatchObject({ code: 'delivery_unknown' })
    await expect(t.app.send('run-a', handle(a))).rejects.toMatchObject({ code: 'delivery_unknown' })
    expect(t.feishu.sent.filter(item => item.kind === 'replyFile')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'unknown' }])
  })

  it('does not return to an invalidated Run after late ACK, while the real Delivery receipt remains sent', async () => {
    const t = fixture(), a = t.file(), entered = deferred(), release = deferred()
    t.feishu.afterFileSend = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.send('run-a', handle(a))).rejects.toMatchObject({ code: 'denied' })
    await entered.promise; t.state.current = false; release.resolve(); await pending
    expect(t.feishu.sent.filter(item => item.kind === 'replyFile')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status,remote_id FROM deliveries').all()).toEqual([{ status: 'sent', remote_id: expect.any(String) }])
  })
})
