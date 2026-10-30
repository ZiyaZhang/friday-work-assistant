import { createHash } from 'node:crypto'
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ExecutionMaterials } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { ExecutionAttachments, type ExecutionAttachmentRun } from '../src/core/execution-attachments.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { FakeFeishu, historyMsg } from './helpers/fake-feishu.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class Feishu extends FakeFeishu {
  data = Buffer.from('current attachment\nneedle')
  receive?: (dest: string) => Promise<void>
  override async downloadMessageResource(messageId: string, fileKey: string, type: 'file' | 'image', dest: string) {
    this.downloads.push({ messageId, fileKey, type, dest })
    if (this.receive) await this.receive(dest)
    else writeFileSync(dest, this.data)
  }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-attachments-test-')), registry = new Registry(join(home, 'db'))
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const cwd = join(home, 'old-cwd'), temp = join(home, 'receiving'); mkdirSync(cwd)
  const msg: InboundMessage = { eventId: 'event-a', tenantId: 'tenant-a', messageId: 'message-a', chatId: 'chat-a', chatType: 'group',
    text: '看一下这个附件', senderType: 'user', senderOpenId: 'alice', createTimeMs: 100, mentions: [],
    msgType: 'file', fileKey: 'synthetic-file-key', fileName: '附件.txt' }
  registry.createSession({ sessionKey: 'session-a', chatId: msg.chatId, chatType: msg.chatType, cwd, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: msg.messageId, requesterOpenId: 'alice', prompt: msg.text }).task
  const attempts = new RunAttempts(registry.db)
  const run = attempts.begin({ sessionKey: task.sessionKey, workKey: `task:${task.id}`, triggerKey: `task:${task.id}`, taskId: task.id,
    actorOpenId: 'alice', stage: 'task', now: 100 }, () => registry.startTask(task.id, 100))!
  attempts.bindRuntime(run.id, 'acp-a')
  const sources = new SourceContexts(registry), binding = { sessionKey: task.sessionKey, spaceId: 'space-a', acpSessionId: 'acp-a', chatId: msg.chatId }
  sources.initialize(binding, ['space:space-a'])
  sources.recordMessages(binding, [{ ref: 'inbound:message-a', tenantId: 'tenant-a', appId: 'app-a', chatId: msg.chatId,
    spaceId: 'space-a', messageId: msg.messageId, readAt: 100, readIdentity: { kind: 'app' }, coverage: 'complete' }], true)
  const feishu = new Feishu(), state = { allowed: true, beforeAuthorize: undefined as undefined | (() => Promise<void>) }
  const material: ExecutionAttachmentRun = {
    context: { sessionKey: task.sessionKey, spaceId: 'space-a', generation: 'acp-a', runId: run.id,
      assertCurrent() { if (!attempts.isCurrent(run.id) || attempts.get(run.id)?.acpSessionId !== 'acp-a') throw new Error('private current Run detail') } },
    assertInbound(input) {
      const receipt = registry.taskForMessage(input.messageId), session = registry.getSession(task.sessionKey)
      if (receipt?.id !== task.id || input.senderOpenId !== task.requesterOpenId || input.chatId !== session?.chatId ||
        input.chatType !== session.chatType || input.senderType !== 'user') throw new Error('private inbound mismatch')
    },
    snapshot: () => ({ sources: sources.get(task.sessionKey)!, memoryRefs: [] }),
    async authorize() { await state.beforeAuthorize?.(); return { assertCurrent() { if (!state.allowed) throw new Error('private lease URL/key') } } },
    consume(provenance) { sources.recordMessages(binding, provenance.sources.messageSources ?? [], true) },
    async deliver() { throw new Error('Attachment intake must not deliver') },
  }
  const files = new ExecutionMaterials(registry.db, join(home, 'content')); files.openGeneration(material.context)
  const app = new ExecutionMaterialApplication({ files, resolveRun: () => material })
  const receiver = new ExecutionAttachments({ feishu, materialApp: app, resolveRun: () => material, tempRoot: temp })
  const count = () => Number(registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n)
  const clean = () => {
    expect(existsSync(temp) ? readdirSync(temp) : []).toEqual([])
    expect(readdirSync(cwd)).toEqual([])
  }
  return { home, registry, attempts, sources, task, run, msg, feishu, state, material, files, app, receiver, count, clean, temp }
}

describe('managed inbound attachment reception with actual Task receipts, SQLite and material application', () => {
  it('receives each post image with the original post receipt and actual byte signature', async () => {
    const t = fixture(); delete t.msg.fileKey; delete t.msg.fileName
    Object.assign(t.msg, { msgType: 'post', imageKey: 'picture-a', imageKeys: ['picture-a', 'picture-b', 'picture-a'] })
    t.feishu.data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const note = await t.receiver.receive(t.run.id, t.msg)
    const files = t.files.list(t.material.context).items
    expect(files).toHaveLength(2)
    expect(t.feishu.downloads.map(item => [item.messageId, item.fileKey, item.type])).toEqual([
      [t.msg.messageId, 'picture-a', 'image'], [t.msg.messageId, 'picture-b', 'image']])
    for (const item of files) {
      const file = t.files.read(t.material.context, { fileId: item.fileId, expectedDigest: item.digest })
      expect(file.data).toEqual(t.feishu.data)
      expect(file.provenance.attachment).toMatchObject({ mediaType: 'image/png', containerMessageId: t.msg.messageId,
        resourceMessageId: t.msg.messageId, actorOpenId: 'alice', contentDigest: item.digest })
    }
    expect(note).not.toMatch(/read_image|friday-inbound-/); t.clean()
  })

  it('receives a real forwarded child through its container without granting the original chat', async () => {
    const t = fixture(); t.msg.msgType = 'merge_forward'; delete t.msg.fileKey
    const child = historyMsg({ messageId: 'child-file', chatId: 'unreadable-original-chat', text: '', msgType: 'file',
      fileKey: 'child-key', fileName: '原附件.txt', senderOpenId: 'other-author' })
    t.feishu.messages.set(t.msg.messageId, historyMsg({ ...t.msg }))
    t.feishu.forwarded.set(t.msg.messageId, [child])
    const note = await t.receiver.receiveForwarded(t.run.id, t.msg, child), item = t.files.list(t.material.context).items[0]!
    const file = t.files.read(t.material.context, { fileId: item.fileId, expectedDigest: item.digest })
    expect(file.data).toEqual(t.feishu.data)
    expect(file.provenance.attachment).toMatchObject({ containerMessageId: t.msg.messageId, resourceMessageId: child.messageId,
      chatId: t.msg.chatId, actorOpenId: 'alice', mediaType: 'application/octet-stream' })
    expect(JSON.stringify(file.provenance.sources)).not.toContain(child.chatId)
    expect(note).toContain(item.fileId)
    expect(t.feishu.downloads[0]).toMatchObject({ messageId: child.messageId, fileKey: 'child-key', type: 'file' })
    await expect(t.receiver.receiveForwarded(t.run.id, t.msg, { ...child, fileKey: 'forged' })).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.downloads).toHaveLength(1); t.clean()
  })

  it('rejects a stop while rechecking the forwarded child before downloading bytes', async () => {
    const t = fixture(), entered = deferred(), release = deferred(); t.msg.msgType = 'merge_forward'
    const child = historyMsg({ messageId: 'child', text: '附件', msgType: 'file', fileKey: 'key' })
    vi.spyOn(t.feishu, 'getMessageItems').mockImplementation(async () => { entered.resolve(); await release.promise; return [child] })
    const pending = expect(t.receiver.receiveForwarded(t.run.id, t.msg, child)).rejects.toThrow()
    await entered.promise; t.attempts.requestStop(t.run.id, 'user_requested'); release.resolve(); await pending
    expect(t.feishu.downloads).toEqual([]); expect(t.count()).toBe(0); t.clean()
  })

  it.each(['file', 'image', 'media'])('registers %s bytes and current sources, returns only a logical handle, and cleans temporary files', async type => {
    const t = fixture(); t.msg.msgType = type
    if (type === 'image') { t.msg.imageKey = 'synthetic-image-key'; delete t.msg.fileKey; delete t.msg.fileName }
    if (type !== 'file') t.feishu.data = Buffer.from([0, 255, 17, 129])
    const before = t.material.snapshot(), note = await t.receiver.receive(t.run.id, t.msg)
    const metadata = t.files.list(t.material.context).items[0]!, file = t.files.read(t.material.context, {
      fileId: metadata.fileId, expectedDigest: metadata.digest, expectedVersion: metadata.version })
    expect(file.data).toEqual(t.feishu.data)
    expect(file.provenance).toEqual({ ...before, attachment: { actorOpenId: 'alice', chatId: t.msg.chatId,
      containerMessageId: t.msg.messageId, resourceMessageId: t.msg.messageId, resourceType: type === 'image' ? 'image' : 'file',
      contentDigest: file.digest, keyDigest: createHash('sha256').update(t.msg.fileKey ?? t.msg.imageKey!).digest('hex'), mediaType: 'application/octet-stream' } })
    expect(file.kind).toBe('input')
    expect(note).toContain(file.fileId); expect(note).toContain(file.digest); expect(note).toContain('尚未解析或查看内容')
    expect(note).not.toContain(t.home); expect(note).not.toContain(t.msg.fileKey ?? t.msg.imageKey!)
    expect(t.feishu.downloads[0]).toMatchObject({ messageId: t.msg.messageId, type: type === 'image' ? 'image' : 'file' })
    expect(t.feishu.sent).toEqual([]); t.clean()
  })

  it.each(['text', 'post', 'merge_forward', 'audio'])('leaves %s to its existing host branch without resolving a Run or downloading', async msgType => {
    const t = fixture(), helper = new ExecutionAttachments({ feishu: t.feishu, materialApp: t.app,
      resolveRun() { throw new Error('must not resolve') }, tempRoot: t.temp })
    expect(await helper.receive('no-run', { ...t.msg, msgType })).toBeUndefined()
    expect(t.feishu.downloads).toEqual([]); expect(t.count()).toBe(0); t.clean()
  })

  it.each(['other-chat', 'other-message', 'other-author', 'no-receipt', 'wrong-run'])('rejects %s before downloading and cannot manufacture permission from a source claim', async reason => {
    const t = fixture(), msg = structuredClone(t.msg)
    if (reason === 'other-chat') msg.chatId = 'private-other-chat'
    if (reason === 'other-message') msg.messageId = 'private-other-message'
    if (reason === 'other-author') msg.senderOpenId = 'bob'
    if (reason === 'no-receipt') t.registry.db.prepare('DELETE FROM task_receipts WHERE task_id=?').run(t.task.id)
    await expect(t.receiver.receive(reason === 'wrong-run' ? 'old-run' : t.run.id, msg)).rejects.toMatchObject({ code: 'denied' })
    expect(t.feishu.downloads).toEqual([]); expect(t.count()).toBe(0); t.clean()
  })

  it.each(['stop', 'source-added', 'acp-changed'])('rejects %s during the download await before registering any bytes', async reason => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.feishu.receive = async dest => { entered.resolve(); await release.promise; writeFileSync(dest, t.feishu.data) }
    const pending = expect(t.receiver.receive(t.run.id, t.msg)).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    if (reason === 'stop') t.attempts.requestStop(t.run.id, 'user_requested')
    if (reason === 'source-added') t.sources.addRepository(t.task.sessionKey, 'test-org/another-source')
    if (reason === 'acp-changed') t.attempts.bindRuntime(t.run.id, 'acp-new')
    release.resolve(); await pending
    expect(t.count()).toBe(0); t.clean()
  })

  it('keeps the captured source guard through register authorization, not only until the download returns', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.receiver.receive(t.run.id, t.msg)).rejects.toMatchObject({ name: 'ExecutionAttachmentError' })
    await entered.promise; t.sources.addRepository(t.task.sessionKey, 'test-org/late-source'); release.resolve(); await pending
    expect(t.count()).toBe(0); t.clean()
  })

  it('copies the inbound fields before await and retries identical message bytes without adding a second version', async () => {
    const t = fixture(), entered = deferred(), release = deferred(), original = structuredClone(t.msg)
    t.feishu.receive = async dest => { entered.resolve(); await release.promise; writeFileSync(dest, t.feishu.data) }
    const pending = t.receiver.receive(t.run.id, t.msg); await entered.promise
    t.msg.fileName = 'changed-by-caller.txt'; t.msg.chatId = 'other-chat'; t.msg.fileKey = 'other-key'
    release.resolve(); const first = await pending
    expect(first).toContain('附件.txt'); expect(first).not.toContain('changed-by-caller')
    t.feishu.receive = undefined
    expect(await t.receiver.receive(t.run.id, original)).toBe(first)
    expect(t.count()).toBe(1)
    t.feishu.data = Buffer.from('changed platform bytes')
    const changed = await t.receiver.receive(t.run.id, original)
    expect(changed).not.toBe(first); expect(t.count()).toBe(2); t.clean()
  })

  it('bounds actual admission at 64 MiB before reading an oversized sparse file', async () => {
    const t = fixture()
    t.feishu.receive = async dest => { const fd = openSync(dest, 'w'); try { ftruncateSync(fd, 64 * 1024 * 1024 + 1) } finally { closeSync(fd) } }
    await expect(t.receiver.receive(t.run.id, t.msg)).rejects.toMatchObject({ code: 'too_large' })
    expect(t.count()).toBe(0); t.clean()
  })

  it.each(['symlink', 'directory', 'partial-error'])('rejects %s download results and never exposes internal paths or raw platform errors', async reason => {
    const t = fixture(), secret = join(t.home, 'private-test-key'); writeFileSync(secret, 'synthetic private bytes')
    t.feishu.receive = async dest => {
      expect(lstatSync(join(dest, '..')).mode & 0o777).toBe(0o700)
      if (reason === 'symlink') symlinkSync(secret, dest)
      if (reason === 'directory') mkdirSync(dest)
      if (reason === 'partial-error') { writeFileSync(dest, 'partial'); throw new Error(`https://secret.invalid/token ${secret}`) }
    }
    let error: unknown
    try { await t.receiver.receive(t.run.id, t.msg) } catch (caught) { error = caught }
    expect(error).toMatchObject({ name: 'ExecutionAttachmentError' })
    expect(String(error)).not.toMatch(/secret|private-test-key|https:/)
    expect(String(error)).not.toContain(t.home)
    expect(t.count()).toBe(0); t.clean()
  })

  it('sanitizes logical display names without using them as download paths', async () => {
    const t = fixture(); t.msg.fileName = '../../private\\报告\n.txt'
    const note = await t.receiver.receive(t.run.id, t.msg), metadata = t.files.list(t.material.context).items[0]!
    expect(note).toContain('报告_.txt'); expect(note).not.toContain('../')
    expect(t.feishu.downloads[0]!.dest.endsWith('/resource')).toBe(true)
    expect(metadata.digest).toBe(createHash('sha256').update(t.feishu.data).digest('hex')); t.clean()
  })

  it('missing resource keys do not consult old files or issue a platform read', async () => {
    const t = fixture(); delete t.msg.fileKey
    await expect(t.receiver.receive(t.run.id, t.msg)).rejects.toMatchObject({ code: 'unavailable' })
    expect(t.feishu.downloads).toEqual([]); expect(t.count()).toBe(0); t.clean()
  })
})
