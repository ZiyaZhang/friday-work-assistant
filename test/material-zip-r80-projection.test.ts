import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ExecutionMaterials, materialProvenanceCovers, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { ExecutionMaterialRuntime } from '../src/core/execution-material-runtime.js'
import { attachmentMediaType } from '../src/core/execution-attachments.js'
import { createManagedZip } from '../src/core/execution-material-zip.js'
import type { DeliveredMessageSource } from '../src/core/delivered-message-source.js'
import type { MyDayDomainSourceReceipt } from '../src/core/personal-assistant-sources.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
const pin = (file: { fileId: string; digest: string }) => ({ fileId: file.fileId, expectedDigest: file.digest })

/** Real Run, runtime context, source record, material store and application in one private chat.
 * Source authorization is a synthetic allow; the canonical tests cover denial. */
function privateChat() {
  const home = mkdtempSync(join(tmpdir(), 'friday-zip-r80-')), registry = new Registry(join(home, 'db'))
  cleanups.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
  const attempts = new RunAttempts(registry.db), contexts = new RuntimeContexts(registry.db), sources = new SourceContexts(registry)
  const { spaces } = spaceDeps(registry.db), dm = spaces.ensure({ kind: 'p2p', chatId: 'oc_dm_alice', openId: 'alice' })
  registry.createSession({ sessionKey: 'dm:alice', chatId: dm.chatId!, chatType: 'p2p', cwd: home, requesterOpenId: 'alice' })
  const task = registry.createTaskOnce({ sessionKey: 'dm:alice', messageId: 'synthetic-request', prompt: 'synthetic request', requesterOpenId: 'alice' }).task
  const run = attempts.begin({ sessionKey: task.sessionKey, workKey: `task:${task.id}`, triggerKey: `task:${task.id}`, taskId: task.id,
    actorOpenId: 'alice', stage: 'task', now: Date.now() }, () => registry.startTask(task.id, Date.now(), task.sessionKey))!
  attempts.bindRuntime(run.id, 'acp-a'); contexts.bind(run.id, run.sessionKey, 'acp-a')
  const binding = { sessionKey: 'dm:alice', acpSessionId: 'acp-a', spaceId: dm.id, chatId: dm.chatId! }, scopes = [`space:${dm.id}`]
  sources.initialize(binding, scopes)
  const runtime = new ExecutionMaterialRuntime({ sources, contexts, access: { check: async () => ({ status: 'allowed' as const, assertCurrent: () => {} }) },
    binding: runId => ({ ...binding, runId, openId: 'alice', chatType: 'p2p' as const, mode: 'managed' as const, readScopes: () => scopes,
      assertCurrent() { if (!attempts.isCurrent(runId)) throw new Error('Run no longer active') },
      deliver: async () => { throw new Error('delivery is not part of this test') } }) })
  const files = new ExecutionMaterials(registry.db, join(home, 'content'))
  files.openGeneration(runtime.resolve(run.id).context)
  const app = new ExecutionMaterialApplication({ files, resolveRun: id => runtime.resolve(id) })
  const myDay: MyDayDomainSourceReceipt = { version: 1, kind: 'todo', id: 7, appId: 'app-a', sourceSpaceId: 'group-space', sourceChatId: 'oc_team',
    sourceScope: 'space:group-space', sourceSessionKey: null, viewerOpenId: 'alice', privateSpaceId: dm.id, privateChatId: dm.chatId!, contentDigest: 'd'.repeat(64) }
  const delivered: DeliveredMessageSource = { ref: 'host-delivered:my-day', deliveryKey: 'task:1:answer', messageId: 'outgoing-1', tenantId: 'tenant-a',
    appId: 'app-a', spaceId: dm.id, chatId: dm.chatId!, chatType: 'p2p', targetOpenId: 'alice', contentDigest: 'b'.repeat(64) }
  const context = () => runtime.resolve(run.id).context
  return { registry, sources, binding, scopes, runtime, files, app, run, dm, myDay, delivered, context }
}

/** Shared-file behaviour this package adds on the r80 base, where My Day, meeting and poll receipts already
 * live in the same source records (canonical has no My Day receipts). */
describe('ZIP on the r80 source records', () => {
  it('keeps My Day and delivered-message receipts through read, a fresh source record and packing, without duplicating them', async () => {
    const t = privateChat()
    t.sources.recordMyDaySource(t.binding, t.myDay)
    t.sources.recordDeliveredMessage(t.binding, t.delivered)
    const file = await t.app.write(t.run.id, { name: 'my-day-summary.txt', text: 'Two of my open items.' }, 'my-day-artifact')
    const stored = t.files.metadata(t.context(), file.fileId, file.digest).provenance
    // Stored provenance is canonical JSON: the same receipt comes back with sorted keys.
    expect(Object.keys(stored.sources.myDaySources![0]!)).toEqual(Object.keys(t.myDay).sort())
    expect(Object.keys(stored.sources.myDaySources![0]!)).not.toEqual(Object.keys(t.myDay))
    await t.app.read(t.run.id, pin(file))
    expect(t.sources.get(t.binding.sessionKey)).toMatchObject({ myDaySources: [t.myDay], deliveredMessages: [t.delivered] })
    // Consumption must repopulate the file's exact dependencies in a fresh record, not borrow its absence.
    t.sources.initialize(t.binding, t.scopes)
    const packed = await t.app.zipPack(t.run.id, { name: 'my-day.zip', files: [pin(file)] }, 'my-day-zip')
    const proof = t.files.metadata(t.context(), packed.fileId, packed.digest).provenance
    expect(proof.sources).toMatchObject({ myDaySources: [t.myDay], deliveredMessages: [t.delivered] })
    expect(proof.archiveInputs).toEqual([{ fileId: file.fileId, digest: file.digest, version: 1, member: 'my-day-summary.txt' }])
    await t.app.read(t.run.id, pin(file))
    await t.app.zipList(t.run.id, pin(packed))
    expect(t.sources.get(t.binding.sessionKey)).toMatchObject({ myDaySources: [t.myDay], deliveredMessages: [t.delivered] })
  })

  it('refuses a derived version that drops a My Day receipt the old version depended on', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-zip-r80-store-')), db = new DatabaseSync(join(home, 'db'))
    cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
    const t = privateChat(), store = new ExecutionMaterials(db, join(home, 'private'), { now: () => 1234 })
    const ctx: MaterialContext = { sessionKey: 'dm:alice', spaceId: t.dm.id, generation: 'acp-a', runId: 'run-a', assertCurrent() {} }
    store.openGeneration(ctx)
    const proof: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: t.dm.id, chatId: t.dm.chatId!,
      memoryScopes: [], chats: [], external: [], repositories: [], myDaySources: [t.myDay] }, memoryRefs: [] }
    const original = store.register(ctx, { operationKey: 'original', name: 'my-day.txt', data: Buffer.from('original'), provenance: proof })
    const edit = (operationKey: string, myDaySources: MyDayDomainSourceReceipt[]) => store.edit(ctx, { fileId: original.fileId, expectedDigest: original.digest,
      operationKey, edits: [{ oldText: 'original', newText: 'changed' }], provenance: { ...structuredClone(proof), sources: { ...structuredClone(proof.sources), myDaySources } } })
    expect(() => edit('drop', [])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(() => edit('replace', [{ ...t.myDay, contentDigest: 'e'.repeat(64) }])).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    const dropped = structuredClone(proof); delete dropped.sources.myDaySources
    expect(materialProvenanceCovers(dropped, proof)).toBe(false)
    expect(materialProvenanceCovers(proof, dropped)).toBe(true)
    expect(edit('keep', [t.myDay, { ...t.myDay, id: 8 }]).provenance.sources.myDaySources).toHaveLength(2)
  })

  it('treats an empty ZIP (end record only) as ZIP: reading gives the unpack hint and listing returns no members', async () => {
    const t = privateChat(), empty = Buffer.from('504b0506' + '00'.repeat(18), 'hex')
    expect(attachmentMediaType(empty)).toBe('application/zip')
    const input = await t.app.register(t.run.id, { name: 'empty.zip', data: empty, provenance: t.runtime.resolve(t.run.id).snapshot() }, 'import-empty')
    await expect(t.app.read(t.run.id, pin(input))).rejects.toMatchObject({ code: 'not_text', message: expect.stringContaining('ZIP') })
    expect(await t.app.zipList(t.run.id, pin(input))).toMatchObject({ entries: [], total: 0, nextOffset: null, complete: true })
  })

  it('does not unpack a nested ZIP; the inner archive is listed only when it is itself selected', async () => {
    const t = privateChat()
    const inner = await createManagedZip([{ name: 'deep/secret.txt', data: Buffer.from('inner facts') }], () => {})
    const outer = await createManagedZip([{ name: 'inner.zip', data: inner }, { name: 'readme.txt', data: Buffer.from('outer') }], () => {})
    const input = await t.app.register(t.run.id, { name: 'outer.zip', data: outer, provenance: t.runtime.resolve(t.run.id).snapshot() }, 'import-outer')
    expect((await t.app.zipList(t.run.id, pin(input))).entries.map(entry => entry.name)).toEqual(['inner.zip', 'readme.txt'])
    const { files: [child] } = await t.app.zipExtract(t.run.id, { ...pin(input), members: ['inner.zip'] }, 'extract-inner')
    await expect(t.app.read(t.run.id, pin(child!))).rejects.toMatchObject({ code: 'not_text' })
    expect((await t.app.zipList(t.run.id, pin(child!))).entries.map(entry => entry.name)).toEqual(['deep/secret.txt'])
    expect(t.files.metadata(t.context(), child!.fileId, child!.digest).provenance.archiveMember).toMatchObject({ fileId: input.fileId, member: 'inner.zip' })
  })
})
