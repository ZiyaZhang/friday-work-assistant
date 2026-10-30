import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { createManagedZip, extractManagedZip, inspectManagedZip, MATERIAL_ZIP_LIMITS } from '../src/core/execution-material-zip.js'
import { ToolDeliveryService } from '../src/core/tool-delivery.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const pin = (file: { fileId: string; digest: string }) => ({ fileId: file.fileId, expectedDigest: file.digest })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real MCP/HTTP/SQLite/material and delivery applications, with synthetic platform
 * and source authorization only. No model, browser or production permission claim. */
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-zip-protocol-')), registry = new Registry(join(home, 'db'))
  const memory = new ChannelMemory(registry.db), memoryHost = memoryRuntimeFixture(registry, memory), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: home, requesterOpenId: 'alice' })
  memoryHost.pin({ runId: 'run-a', sessionKey: 'session-a', actorOpenId: 'alice' })
  const state = { runId: 'run-a', actor: 'alice', denied: false, beforeAuthorize: undefined as (() => Promise<void>) | undefined }
  const context: MaterialContext = { runId: 'run-a', sessionKey: 'session-a', spaceId: space.id, generation: 'generation-a',
    assertCurrent() { if (state.runId !== 'run-a' || state.actor !== 'alice') throw new Error('host binding changed') } }
  const sources = new SourceContexts(registry), binding = { sessionKey: context.sessionKey, acpSessionId: 'acp-a', spaceId: space.id, chatId: 'chat-a' }
  sources.initialize(binding, [])
  const provenance: MaterialProvenance = { sources: sources.get(context.sessionKey)!, memoryRefs: [] }
  provenance.sources.external.push({ kind: 'document', ref: 'private-original-source', access: 'user', personalOpenId: 'alice' })
  const files = new ExecutionMaterials(registry.db, join(home, 'content')); files.openGeneration(context)
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('zip-protocol', 'error')
  const consumed: MaterialProvenance[] = [], authorized: MaterialProvenance[] = []
  const app = new ExecutionMaterialApplication({ files, resolveRun(runId) {
    if (runId !== state.runId) throw new Error('stale run')
    return { context, snapshot: () => ({ sources: sources.get(context.sessionKey)!, memoryRefs: [] }), async authorize(proof) {
      authorized.push(structuredClone(proof)); await state.beforeAuthorize?.()
      return { assertCurrent() { if (state.denied && proof.sources.external.some(item => item.ref === 'private-original-source')) throw new Error('source revoked') } }
    }, consume(proof) {
      consumed.push(structuredClone(proof))
      for (const item of proof.sources.external) sources.addExternal(context.sessionKey, item)
    }, async deliver(input, guard) {
      return new ToolDeliveryService(registry.db, { ...sp, feishu, contextRef: 'task:1:session:a', keyPrefix: 'task:1', assertCurrent: guard,
        resolveContext: async () => ({ actorOpenId: 'alice', expiresAt: Date.now() + 60_000, provenanceComplete: true,
          sources: [{ ref: 'synthetic-authorized-private-source', spaceId: space.id, chatId: 'chat-a' }],
          audience: { kind: 'group', spaceId: space.id, chatId: 'chat-a', replyToMessageId: 'original-message' } }) }).send({ kind: 'file', ...input })
    } }
  } })
  const tokens = new TokenIssuer('synthetic-only'), cap: Capability = { sessionKey: context.sessionKey, runId: context.runId,
    requesterOpenId: 'alice', chatId: 'chat-a', chatType: 'group', spaceId: space.id, cwd: home, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, ...sp, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10, materials: app,
    resolveActorForSession: () => ({ requesterOpenId: state.actor, runId: state.runId, stage: 'task' }) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanups.push(async () => { api.server.closeAllConnections(); await new Promise<void>(done => api.server.close(() => done())); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const post = (operation: string, body: Record<string, unknown>, override: Partial<Capability> = {}) => fetch(`${base}/v1/files/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const server = buildServer({ apiUrl: base, token: tokens.issue(cap) }), client = new Client({ name: 'zip-protocol', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close() })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
  }
  let serial = 0
  const register = (data: Buffer, name = 'input.zip') => files.register(context, { name, data, operationKey: `import-${++serial}`, provenance })
  const count = () => Number(registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()!.n)
  return { home, registry, files, context, provenance, state, consumed, authorized, app, fake, call, post, client, register, count, sources }
}

describe('ZIP tools through signed HTTP and managed file delivery', () => {
  it('lists every page, selects members, reads content, creates artifacts, packs and sends the exact version once to the original message', async () => {
    const t = await fixture(), input = t.register(await createManagedZip([
      { name: 'notes/说明.txt', data: Buffer.from('事实一\n事实二') }, { name: 'logs/state.json', data: Buffer.from('{"state":"unknown"}') },
    ], () => {}))
    const first = await t.call('friday_list_zip_members', { ...pin(input), limit: 1 })
    expect(first).toMatchObject({ total: 2, nextOffset: 1, complete: false, entries: [{ name: 'notes/说明.txt' }] })
    expect(t.count()).toBe(1); expect(t.consumed.at(-1)?.sources.external).toEqual(t.provenance.sources.external)
    const second = await t.call('friday_list_zip_members', { ...pin(input), offset: first.nextOffset, limit: 1 })
    expect(second).toMatchObject({ total: 2, nextOffset: null, complete: true, entries: [{ name: 'logs/state.json' }] })
    const extraction = { ...pin(input), members: ['notes/说明.txt', 'logs/state.json'] }
    const selected = await t.call('friday_extract_zip_members', extraction)
    expect(await t.call('friday_extract_zip_members', extraction)).toEqual(selected)
    expect(t.count()).toBe(3)
    expect(await t.call('friday_read_file', pin(selected.files[0]))).toMatchObject({ text: '事实一\n事实二', name: '说明.txt' })
    expect(await t.call('friday_read_file', pin(selected.files[1]))).toMatchObject({ text: '{"state":"unknown"}' })
    const proof = t.files.metadata(t.context, selected.files[0].fileId, selected.files[0].digest).provenance
    expect(proof.sources).toEqual(t.provenance.sources)
    expect(proof.archiveMember).toMatchObject({ fileId: input.fileId, digest: input.digest, version: 1, member: 'notes/说明.txt' })
    const a = await t.call('friday_write_file', { name: 'summary.txt', text: '仅总结已核验事实。' })
    const b = await t.call('friday_write_file', { name: 'index.html', text: '<button onclick="this.textContent=\'已打开\'">打开</button>' })
    const request = { name: 'review.zip', files: [{ ...pin(a), member: 'summary.txt' }, { ...pin(b), member: 'prototype/index.html' }] }
    const packed = await t.call('friday_pack_files', request)
    expect(await t.call('friday_pack_files', request)).toEqual(packed)
    expect(t.files.metadata(t.context, packed.fileId, packed.digest).provenance.sources.external).toEqual(t.provenance.sources.external)
    const sent = await t.call('friday_send_material', pin(packed))
    expect(sent).toMatchObject({ status: 'sent', replayed: false })
    expect(await t.call('friday_send_material', pin(packed))).toMatchObject({ messageId: sent.messageId, replayed: true })
    expect(t.fake.sent.filter(item => item.kind === 'replyFile')).toMatchObject([{ target: 'original-message' }])
    const uploaded = t.fake.uploads[0]!.path
    expect(Buffer.isBuffer(uploaded)).toBe(true)
    expect((await inspectManagedZip(uploaded as Buffer, () => {})).map(entry => entry.name)).toEqual(['summary.txt', 'prototype/index.html'])
    expect((await extractManagedZip(uploaded as Buffer, ['summary.txt'], () => {}))[0]!.data.toString()).toBe('仅总结已核验事实。')
    expect(JSON.stringify([first, second, selected, packed, sent])).not.toMatch(/provenance|archiveMember|archiveInputs|spaceId|sessionKey|generation|private-original-source/)
    expect(JSON.stringify(selected)).not.toContain(t.home)
  })

  it('does not treat ZIP or selected binary members as UTF-8 text, while allowing an image member through the existing image channel', async () => {
    const t = await fixture()
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    const input = t.register(await createManagedZip([{ name: 'binary.bin', data: Buffer.from([0xff, 0, 0x80]) }, { name: 'image.png', data: png }], () => {}))
    expect((await t.post('read', pin(input))).status).toBe(400)
    const selected = await t.call('friday_extract_zip_members', { ...pin(input), members: ['binary.bin', 'image.png'] })
    expect((await t.post('read', pin(selected.files[0]))).status).toBe(400)
    const image = await t.client.callTool({ name: 'friday_read_file', arguments: pin(selected.files[1]) })
    expect(image.isError).not.toBe(true)
    expect(image.content).toMatchObject([{ type: 'text' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }])
  })

  it('preserves source denial on children and packed artifacts, and rejects stale archive/file versions', async () => {
    const t = await fixture(), input = t.register(await createManagedZip([{ name: 'item.txt', data: Buffer.from('private facts') }], () => {}))
    const selected = await t.call('friday_extract_zip_members', { ...pin(input), members: ['item.txt'] })
    const artifact = await t.call('friday_write_file', { name: 'summary.txt', text: 'Derived private facts' })
    const packed = await t.call('friday_pack_files', { name: 'summary.zip', files: [pin(artifact)] })
    t.state.denied = true
    for (const [operation, body] of [['zip/list', pin(input)], ['read', pin(selected.files[0])], ['send', pin(packed)]]) {
      expect((await t.post(operation as string, body as Record<string, unknown>)).status).toBe(403)
    }
    expect(t.fake.sent).toHaveLength(0)
    t.state.denied = false
    const updated = await t.call('friday_edit_file', { ...pin(artifact), edits: [{ oldText: 'facts', newText: 'evidence' }] })
    expect((await t.post('zip/pack', { name: 'stale.zip', files: [pin(artifact)] })).status).toBe(409)
    expect((await t.post('zip/extract', { ...pin(input), expectedDigest: '0'.repeat(64), members: ['item.txt'] })).status).toBe(409)
    expect(await t.call('friday_pack_files', { name: 'updated.zip', files: [pin(updated)] })).toMatchObject({ name: 'updated.zip' })
  })

  it('requires both file read and write for transformations, rejects injected authority and cannot read another session', async () => {
    const t = await fixture(), input = t.register(await createManagedZip([{ name: 'a.txt', data: Buffer.from('a') }], () => {}))
    const extract = { ...pin(input), members: ['a.txt'] }
    for (const scopes of [['file:read'], ['file:write']]) expect((await t.post('zip/extract', extract, { scopes: scopes as Capability['scopes'] })).status).toBe(403)
    expect((await t.post('zip/list', pin(input), { scopes: ['file:read'] })).status).toBe(200)
    for (const key of ['path', 'provenance', 'expectedVersion', 'operationKey']) {
      expect((await t.post('zip/extract', { ...extract, [key]: 'forged' })).status).toBe(400)
      expect((await t.client.callTool({ name: 'friday_extract_zip_members', arguments: { ...extract, [key]: 'forged' } })).isError).toBe(true)
    }
    const other = { ...t.context, sessionKey: 'other-session', generation: 'other-generation' }
    t.files.openGeneration(other)
    const foreign = t.files.register(other, { operationKey: 'other-archive', name: 'PRIVATE_NAME.zip', data: Buffer.from('PRIVATE_CONTENT'), provenance: t.provenance })
    const denied = await t.post('zip/list', pin(foreign))
    expect(denied.status).toBe(404); expect(JSON.stringify(await denied.json())).not.toMatch(/PRIVATE_NAME|PRIVATE_CONTENT/)
    expect(t.count()).toBe(2)
  })

  it('publishes no selected member when another is corrupt or oversized, and rolls back all member rows on a store error', async () => {
    const t = await fixture(), data = await createManagedZip([{ name: 'one.txt', data: Buffer.from('one') }, { name: 'two.txt', data: Buffer.from('two') }], () => {})
    // Change the second central-directory CRC. The first member is valid, but neither may publish.
    const first = data.indexOf(Buffer.from('504b0102', 'hex')), second = data.indexOf(Buffer.from('504b0102', 'hex'), first + 4)
    const corrupt = Buffer.from(data); corrupt.writeUInt32LE(0, second + 16)
    const bad = t.register(corrupt)
    expect((await t.post('zip/extract', { ...pin(bad), members: ['one.txt', 'two.txt'] })).status).toBe(400)
    expect(t.count()).toBe(1)
    const large = Buffer.from(data); large.writeUInt32LE(MATERIAL_ZIP_LIMITS.bytes + 1, first + 24)
    const huge = t.register(large)
    expect((await t.post('zip/extract', { ...pin(huge), members: ['one.txt'] })).status).toBe(413)
    expect(t.count()).toBe(2)
    const good = t.register(data)
    t.registry.db.exec("CREATE TRIGGER reject_second_zip BEFORE INSERT ON execution_material_versions WHEN NEW.name='two.txt' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END")
    expect((await t.post('zip/extract', { ...pin(good), members: ['one.txt', 'two.txt'] })).status).not.toBe(200)
    expect(t.count()).toBe(3)
  })

  it('returns no ZIP directory or output after current Run changes during source authorization', async () => {
    const t = await fixture(), input = t.register(await createManagedZip([{ name: 'PRIVATE_MEMBER.txt', data: Buffer.from('secret') }], () => {}))
    const entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = t.post('zip/extract', { ...pin(input), members: ['PRIVATE_MEMBER.txt'] })
    await entered.promise; t.state.runId = 'replacement-run'; release.resolve()
    const response = await pending
    expect(response.status).toBe(403); expect(JSON.stringify(await response.json())).not.toMatch(/PRIVATE_MEMBER|secret/)
    expect(t.count()).toBe(1)
  })
})
