import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ExecutionMaterials } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { ExecutionMaterialRuntime, type MaterialExecutionBinding } from '../src/core/execution-material-runtime.js'
import { ExecutionSourceAccess } from '../src/core/execution-source-access.js'
import { ToolDeliveryService } from '../src/core/tool-delivery.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class Feishu extends FakeFeishu {
  beforeMembers?: () => Promise<void>
  beforeUpload?: () => Promise<void>
  override async chatMemberOpenIds(chatId: string) { await this.beforeMembers?.(); return super.chatMemberOpenIds(chatId) }
  override async uploadFile(data: string | Buffer, name: string) { const key = await super.uploadFile(data, name); await this.beforeUpload?.(); return key }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-material-runtime-')), registry = new Registry(join(home, 'db'))
  cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const memory = new ChannelMemory(registry.db), attempts = new RunAttempts(registry.db), contexts = new RuntimeContexts(registry.db)
  const sources = new SourceContexts(registry), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: home, requesterOpenId: 'alice' })
  let serial = 0
  const createRun = (acpSessionId: string) => {
    const task = registry.createTaskOnce({ sessionKey: 'session-a', messageId: `synthetic-message-${++serial}`, prompt: 'synthetic original request', requesterOpenId: 'alice' }).task
    const run = attempts.begin({ sessionKey: task.sessionKey, workKey: `task:${task.id}`, triggerKey: `task:${task.id}`,
      taskId: task.id, actorOpenId: 'alice', stage: 'task', now: Date.now() }, () => registry.startTask(task.id, Date.now(), task.sessionKey))!
    attempts.bindRuntime(run.id, acpSessionId); contexts.bind(run.id, run.sessionKey, acpSessionId)
    return attempts.get(run.id)!
  }
  const run = createRun('acp-a'), scopes = ['org', `space:${space.id}`]
  const bindingBase = { sessionKey: run.sessionKey, acpSessionId: 'acp-a', spaceId: space.id, chatId: 'chat-a' }
  sources.initialize(bindingBase, scopes)
  sources.recordMessages(bindingBase, [{ ref: 'message:chat-a:original', tenantId: 'tenant-a', appId: 'app-a', spaceId: space.id,
    chatId: 'chat-a', messageId: 'original', readIdentity: { kind: 'app' }, readAt: 100, coverage: 'complete' }], true)
  const fake = new Feishu(); fake.members.set('chat-a', new Set(['alice'])); fake.chats = [{ chatId: 'chat-a', name: 'synthetic group' }]
  const feishu = asFeishuClient(fake), state = { mode: 'managed' as 'managed' | 'workspace', repositoryAllowed: true }
  const validDeliveredProofs = new Set<string>()
  const access = new ExecutionSourceAccess({ ...sp, feishu, appId: 'app-a', repositoryAllowed: () => state.repositoryAllowed,
    verifyDeliveredMessage: source => [...validDeliveredProofs].some(proof => isDeepStrictEqual(source, JSON.parse(proof))),
    personalMemory: { checkRead: async () => { throw new Error('No personal source in this group fixture') } },
    userReads: { open: async () => { throw new Error('No user OAuth in this group fixture') } } })
  const binding = (runId: string): MaterialExecutionBinding => {
    const current = attempts.get(runId), session = current && registry.getSession(current.sessionKey)
    if (!current?.acpSessionId || !session) throw new Error('unbound execution')
    return { runId, sessionKey: current.sessionKey, acpSessionId: current.acpSessionId, spaceId: space.id,
      chatId: session.chatId, chatType: session.chatType, openId: current.actorOpenId!, mode: state.mode,
      readScopes: () => scopes,
      assertCurrent() { if (!attempts.isCurrent(runId)) throw new Error('Run no longer active') },
      async deliver(file, guard) {
        const service = new ToolDeliveryService(registry.db, { ...sp, feishu, contextRef: `task:${current.taskId}:session:a`, keyPrefix: `task:${current.taskId}`,
          assertCurrent: guard, resolveContext: async () => ({ actorOpenId: 'alice', provenanceComplete: true, expiresAt: Date.now() + 60_000,
            sources: [{ ref: 'original', spaceId: space.id, chatId: 'chat-a' }],
            audience: { kind: 'group', spaceId: space.id, chatId: 'chat-a', replyToMessageId: 'original' } }) })
        return service.send({ kind: 'file', ...file })
      } }
  }
  const runtime = new ExecutionMaterialRuntime({ contexts, sources, access, binding })
  const files = new ExecutionMaterials(registry.db, join(home, 'content'))
  files.openGeneration(runtime.resolve(run.id).context)
  const app = new ExecutionMaterialApplication({ files, resolveRun: id => runtime.resolve(id) })
  const note = memory.add({ scope: `space:${space.id}`, kind: 'fact', title: 'synthetic fact', body: 'current source fact', status: 'candidate' })
  contexts.recordRead(run.id, [{ id: note.id, revision: note.revision }])
  return { registry, memory, attempts, contexts, sources, space, scopes, fake, state, runtime, files, app, run, note, bindingBase, createRun, binding, validDeliveredProofs }
}
const pin = (file: { fileId: string; digest: string }) => ({ fileId: file.fileId, expectedDigest: file.digest })

describe('material host adapter with real Run, context, source authorization and material stores', () => {
  it('packing preserves an older artifact\'s inbound and delivered source proofs and cannot launder a later revoked host receipt', async () => {
    const t = fixture()
    const inbound = { messageId: 'forward-container', chatId: 'chat-a', actorOpenId: 'alice', digest: 'a'.repeat(64), complete: true }
    const delivered = { ref: 'host-delivered:original', deliveryKey: 'task:old:question', messageId: 'outgoing-original',
      tenantId: 'tenant-a', appId: 'app-a', spaceId: t.space.id, chatId: 'chat-a', chatType: 'group' as const,
      targetOpenId: 'alice', contentDigest: 'b'.repeat(64) }
    t.validDeliveredProofs.add(JSON.stringify(delivered))
    t.sources.recordInboundMaterial(t.bindingBase, inbound)
    t.sources.recordDeliveredMessage(t.bindingBase, delivered)
    const file = await t.app.write(t.run.id, { name: 'summary.txt', text: 'Based on supplied materials and the delivered question.' }, 'proof-artifact')
    await t.app.read(t.run.id, pin(file))
    expect(t.runtime.resolve(t.run.id).snapshot().sources.deliveredMessages).toEqual([delivered])
    // The file is durable; consumption must repopulate its exact dependencies,
    // not just borrow the new context's lack of recorded sources.
    t.sources.initialize(t.bindingBase, t.scopes)
    const packed = await t.app.zipPack(t.run.id, { name: 'summary.zip', files: [pin(file)] }, 'proof-zip')
    const proof = t.files.metadata(t.runtime.resolve(t.run.id).context, packed.fileId, packed.digest).provenance
    expect(proof.sources.inboundMaterials).toEqual([inbound])
    expect(proof.sources.deliveredMessages).toEqual([delivered])
    expect(t.runtime.resolve(t.run.id).snapshot().sources.deliveredMessages).toEqual([delivered])
    // Persistence canonicalizes key order. Reading a file must not make that
    // identical host receipt a second source in the active context.
    await t.app.read(t.run.id, pin(file))
    expect(t.runtime.resolve(t.run.id).snapshot().sources.deliveredMessages).toEqual([delivered])
    t.validDeliveredProofs.clear()
    await expect(t.app.zipList(t.run.id, pin(packed))).rejects.toMatchObject({ code: 'denied' })
    await expect(t.app.send(t.run.id, pin(packed))).rejects.toMatchObject({ code: 'denied' })
    expect(t.fake.sent).toEqual([])
  })
  it('retains exact ordinary conversation proof through write, read, edit and exported artifact provenance', async () => {
    const t = fixture()
    const receipt = { complete: true, items: [{ kind: 'message' as const, appId: 'app-a', chatId: 'chat-a', spaceId: t.space.id,
      messageId: 'original', contentDigest: 'a'.repeat(64), readIdentity: { kind: 'app' as const } }] }
    t.sources.recordConversationReads(t.bindingBase, receipt)
    const before = t.runtime.resolve(t.run.id).snapshot()
    const first = await t.app.write(t.run.id, { name: 'summary.txt', text: 'first' }, 'conversation-write')
    expect(t.files.metadata(t.runtime.resolve(t.run.id).context, first.fileId, first.digest).provenance).toEqual(before)
    expect(await t.app.read(t.run.id, pin(first))).toMatchObject({ text: 'first' })
    const edited = await t.app.edit(t.run.id, { ...pin(first), edits: [{ oldText: 'first', newText: 'second' }] }, 'conversation-edit')
    expect(await t.app.send(t.run.id, pin(edited))).toMatchObject({ status: 'sent' })
    expect(t.files.metadata(t.runtime.resolve(t.run.id).context, edited.fileId, edited.digest).provenance.sources.conversationReads).toEqual(receipt)
    expect(t.sources.get(t.run.sessionKey)?.conversationReads).toEqual(receipt)
  })

  it('consuming a legacy registered file cannot be certified by a later same-chat message receipt', async () => {
    const t = fixture(), run = t.runtime.resolve(t.run.id), old = run.snapshot()
    delete old.sources.conversationReads
    const input = t.files.register(run.context, { operationKey: 'legacy-input', name: 'legacy.txt', data: Buffer.from('legacy material'), provenance: old })
    expect(await t.app.read(t.run.id, pin(input))).toMatchObject({ text: 'legacy material' })
    expect(t.sources.get(t.run.sessionKey)?.conversationReads).toEqual({ complete: false, items: [] })
    const source = { kind: 'message' as const, appId: 'app-a', chatId: 'chat-a', spaceId: t.space.id,
      messageId: 'new-message', contentDigest: 'b'.repeat(64), readIdentity: { kind: 'app' as const } }
    t.sources.recordConversationReads(t.bindingBase, { complete: true, items: [source] })
    expect(t.sources.get(t.run.sessionKey)?.conversationReads).toEqual({ complete: false, items: [source] })
  })

  it.each([false, true])('write/read/edit/send preserve a truly idempotent SourceContexts snapshot (legacy optional field absent=%s)', async absent => {
    const t = fixture()
    if (absent) {
      const manifest = t.sources.get(t.run.sessionKey)!
      delete manifest.messageSources
      t.registry.setKv(`delivery-sources:${t.run.sessionKey}`, JSON.stringify(manifest))
    }
    const before = t.runtime.resolve(t.run.id).snapshot()
    const a = await t.app.write(t.run.id, { name: 'summary.txt', text: 'Cause unknown.' }, 'write-a')
    expect(t.files.metadata(t.runtime.resolve(t.run.id).context, a.fileId, a.digest).provenance).toEqual(before)
    expect(await t.app.read(t.run.id, pin(a))).toMatchObject({ text: 'Cause unknown.', truncated: false })
    const b = await t.app.edit(t.run.id, { ...pin(a), edits: [{ oldText: 'unknown', newText: 'not established' }] }, 'edit-a')
    expect(await t.app.read(t.run.id, pin(b))).toMatchObject({ text: 'Cause not established.' })
    expect(await t.app.send(t.run.id, pin(b))).toMatchObject({ status: 'sent', messageId: expect.any(String) })
    expect(t.runtime.resolve(t.run.id).snapshot()).toEqual(before)
    expect(t.contexts.contextForRun(t.run.id)?.notes).toEqual([{ id: t.note.id, revision: t.note.revision }])
    expect(t.fake.of('replyFile')).toHaveLength(1)
    expect(t.attempts.get(t.run.id)?.state).toBe('running')
  })

  it('a metadata import cannot claim a memory version the actual ACP has not consumed', async () => {
    const t = fixture(), material = t.runtime.resolve(t.run.id), provenance = material.snapshot()
    const extra = t.memory.add({ scope: `space:${t.space.id}`, kind: 'fact', title: 'not read', body: 'not part of ACP history' })
    provenance.memoryRefs.push({ id: extra.id, revision: extra.revision })
    await expect(t.app.register(t.run.id, { name: 'host-input.txt', data: Buffer.from('data'), provenance }, 'import-extra'))
      .rejects.toMatchObject({ code: 'denied' })
    expect(t.files.list(material.context).total).toBe(0)
    expect(t.contexts.contextForRun(t.run.id)?.notes).toHaveLength(1)
  })

  it.each(['workspace', 'old-source-acp', 'other-bound-acp', 'stop', 'memory-revision'] as const)('rejects %s using actual persistent context facts without publishing a file', async reason => {
    const t = fixture()
    if (reason === 'workspace') t.state.mode = 'workspace'
    if (reason === 'old-source-acp') t.sources.initialize({ ...t.bindingBase, acpSessionId: 'old-acp' }, t.scopes)
    if (reason === 'other-bound-acp') t.attempts.bindRuntime(t.run.id, 'other-acp')
    if (reason === 'stop') t.attempts.requestStop(t.run.id, 'user_requested')
    if (reason === 'memory-revision') t.memory.confirm(t.note.id, `space:${t.space.id}`, { by: 'alice', messageId: 'real-confirm-message' })
    await expect(t.app.write(t.run.id, { name: 'denied.txt', text: 'not published' }, 'denied-write')).rejects.toMatchObject({ code: 'denied' })
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n).toBe(0)
    expect(t.fake.sent).toEqual([])
  })

  it('old Run handles stop working, a new Run may resume the same authorized ACP, and a replacement ACP cannot borrow its material IDs', async () => {
    const t = fixture(), old = t.runtime.resolve(t.run.id)
    const file = await t.app.write(t.run.id, { name: 'saved.txt', text: 'current generation' }, 'write')
    t.attempts.finish(t.run.id, 'completed', Date.now())
    const same = t.createRun('acp-a')
    expect(() => old.context.assertCurrent()).toThrow()
    await expect(t.app.read(t.run.id, pin(file))).rejects.toMatchObject({ code: 'denied' })
    expect(await t.app.read(same.id, pin(file))).toMatchObject({ text: 'current generation' })
    t.attempts.finish(same.id, 'completed', Date.now())
    const next = t.createRun('acp-b')
    t.sources.initialize({ ...t.bindingBase, acpSessionId: 'acp-b' }, t.scopes)
    t.files.openGeneration(t.runtime.resolve(next.id).context)
    await expect(t.app.read(next.id, pin(file))).rejects.toMatchObject({ code: 'not_found' })
    expect(t.contexts.contextForRun(next.id)?.notes).toEqual([])
    expect(t.files.list(t.runtime.resolve(next.id).context).items).toEqual([])
  })

  it.each(['stop', 'memory-revision', 'scope', 'repository'] as const)('source authorization await detects %s changes before any bytes or metadata publish', async reason => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.sources.addRepository(t.run.sessionKey, 'test-org/test-repo')
    t.fake.beforeMembers = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.write(t.run.id, { name: 'must-not-write.txt', text: 'held' }, 'held')).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    if (reason === 'stop') t.attempts.requestStop(t.run.id, 'user_requested')
    if (reason === 'memory-revision') t.memory.confirm(t.note.id, `space:${t.space.id}`, { by: 'alice', messageId: 'confirmation-during-await' })
    if (reason === 'scope') t.scopes.splice(0, 1)
    if (reason === 'repository') t.state.repositoryAllowed = false
    release.resolve(); await pending
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n).toBe(0)
    expect(t.fake.sent).toEqual([])
  })

  it('source additions during authorization are not lost from the full snapshot and prevent stale output registration', async () => {
    const t = fixture(), entered = deferred(), release = deferred()
    t.fake.beforeMembers = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.write(t.run.id, { name: 'held.txt', text: 'output' }, 'held')).rejects.toMatchObject({ code: 'context_changed' })
    await entered.promise
    t.sources.addRepository(t.run.sessionKey, 'test-org/new-source')
    release.resolve(); await pending
    expect(t.sources.get(t.run.sessionKey)?.repositories).toEqual(['test-org/new-source'])
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n).toBe(0)
  })

  it('holds the real memory dependency guard through file upload, so a confirmed revision cannot post stale output', async () => {
    const t = fixture(), file = await t.app.write(t.run.id, { name: 'summary.txt', text: 'from the old note' }, 'write')
    const entered = deferred(), release = deferred()
    t.fake.beforeUpload = async () => { entered.resolve(); await release.promise }
    const pending = expect(t.app.send(t.run.id, pin(file))).rejects.toMatchObject({ code: 'denied' })
    await entered.promise
    t.memory.confirm(t.note.id, `space:${t.space.id}`, { by: 'alice', messageId: 'confirm-during-upload' })
    release.resolve(); await pending
    expect(t.fake.of('replyFile')).toEqual([])
    expect(t.registry.db.prepare('SELECT * FROM deliveries').all()).toEqual([])
  })
})
