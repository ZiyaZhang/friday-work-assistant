import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
// Signature fixtures exercise MIME dispatch; pixel decoding belongs to the model provider.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9])
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function setup(data = PNG, name = 'attachment.bin') {
  const home = mkdtempSync(join(tmpdir(), 'friday-image-protocol-')), registry = new Registry(join(home, 'db'))
  const memory = new ChannelMemory(registry.db), memoryHost = memoryRuntimeFixture(registry, memory), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-image', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-image', chatId: 'chat-image', chatType: 'group', cwd: home, requesterOpenId: 'alice' })
  memoryHost.pin({ runId: 'run-image', sessionKey: 'session-image', actorOpenId: 'alice' })
  const state = { runId: 'run-image', sourceAllowed: true, beforeAuthorize: undefined as undefined | (() => Promise<void>),
    afterConsume: undefined as undefined | (() => void) }
  const context: MaterialContext = { runId: 'run-image', sessionKey: 'session-image', spaceId: space.id, generation: 'generation-image',
    assertCurrent() { if (state.runId !== 'run-image') throw new Error('synthetic stopped') } }
  const provenance: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-image', spaceId: space.id, chatId: 'chat-image',
    memoryScopes: [], chats: [], external: [], repositories: [], messageSources: [], personalMemoryComplete: true }, memoryRefs: [],
    attachment: { containerMessageId: 'original-post', resourceMessageId: 'original-image', chatId: 'chat-image', actorOpenId: 'alice',
      resourceType: 'image', keyDigest: 'a'.repeat(64), contentDigest: createHash('sha256').update(data).digest('hex'), mediaType: 'image/png' } }
  const files = new ExecutionMaterials(registry.db, join(home, 'content')); files.openGeneration(context)
  const fixture = files.register(context, { operationKey: 'host-attachment', name, data, provenance })
  const consume = vi.fn(() => { state.afterConsume?.() })
  const authorize = vi.fn(async (_provenance: MaterialProvenance) => {
    await state.beforeAuthorize?.()
    return { assertCurrent() { if (!state.sourceAllowed) throw new Error('source withdrawn') } }
  })
  const app = new ExecutionMaterialApplication({ files, resolveRun: runId => {
    if (runId !== state.runId) throw new Error('old run')
    return { context, snapshot: () => structuredClone(provenance), authorize, consume, async deliver() { throw new Error('not used') } }
  } })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('image-protocol', 'error')
  const tokens = new TokenIssuer('synthetic-secret'), cap: Capability = { sessionKey: context.sessionKey, runId: context.runId, requesterOpenId: 'alice',
    chatId: 'chat-image', chatType: 'group', spaceId: space.id, cwd: home, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, ...sp, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10, materials: app,
    resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: state.runId, stage: 'task' }) })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanup.push(async () => { api.server.closeAllConnections(); await new Promise<void>(done => api.server.close(() => done())); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const server = buildServer({ apiUrl: base, token: tokens.issue(cap) }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'material-image-protocol', version: '1' }); await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  const call = (patch: Record<string, unknown> = {}) => client.callTool({ name: 'friday_read_file', arguments: { fileId: fixture.fileId, expectedDigest: fixture.digest, ...patch } })
  return { app, files, context, fixture, home, provenance, consume, authorize, state, call, client }
}

describe('managed image bytes through real MCP → HTTP → application', () => {
  it.each([['image/png', PNG], ['image/jpeg', JPEG], ['image/gif', GIF], ['image/webp', WEBP]] as const)
    ('returns %s as real MCP image content, never base64 text or a native file path', async (mimeType, data) => {
      const t = await setup(data), response = await t.call()
      expect(response.isError).not.toBe(true)
      const content = response.content as { type: string; text?: string; data?: string; mimeType?: string }[]
      expect(content).toHaveLength(2)
      expect(content[1]).toEqual({ type: 'image', mimeType, data: data.toString('base64') })
      expect(Buffer.from(content[1]!.data!, 'base64')).toEqual(data)
      const metadata = JSON.parse(content[0]!.text!)
      expect(metadata).toEqual({ fileId: t.fixture.fileId, digest: t.fixture.digest, version: 1, name: 'attachment.bin', size: data.length, mediaType: mimeType, truncated: false })
      expect(content[0]!.text).not.toMatch(/base64|\/friday-|original-image|keyDigest|contentDigest/)
      expect(content[0]!.text).not.toContain(data.toString('base64'))
      expect(t.authorize).toHaveBeenCalledWith(t.provenance)
      expect(t.consume).toHaveBeenCalledWith(t.provenance)
    })
  it('reads a misleading .png filename as text based on actual bytes', async () => {
    const t = await setup(Buffer.from('ordinary text\n'), 'not-an-image.png'), response = await t.call()
    expect(response.isError).not.toBe(true)
    expect(response.content).toEqual([{ type: 'text', text: expect.stringContaining('ordinary text') }])
  })
  it('rejects unsupported binary rather than pretending it is a visible image', async () => {
    const t = await setup(Buffer.from([0x42, 0x4d, 0, 0, 0, 0]), 'sample.bmp'), response = await t.call()
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('not_text')
    expect(t.consume).not.toHaveBeenCalled()
  })
  it.each([{ maxBytes: PNG.length - 1 }, { startLine: 1 }, { endLine: 1 }])('does not truncate binary or treat lines as image slices: %j', async options => {
    const t = await setup(), response = await t.call(options)
    expect(response.isError).toBe(true)
    expect((response.content as { type: string }[]).every(block => block.type === 'text')).toBe(true)
    expect(t.consume).not.toHaveBeenCalled()
  })
  it('accepts exact image byte cap and rejects >1MiB before exposing any image bytes', async () => {
    const t = await setup(), exact = await t.call({ maxBytes: PNG.length })
    expect(exact.isError).not.toBe(true)
    const large = await setup(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))
    const denied = await large.call()
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('未截断发送')
    expect(large.consume).not.toHaveBeenCalled()
  })
  it.each(['source', 'run'] as const)('withholds pixels when %s is revoked during source authorization', async kind => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const response = t.call(); await entered.promise
    if (kind === 'source') t.state.sourceAllowed = false
    else t.state.runId = 'run-new'
    release.resolve()
    expect((await response).isError).toBe(true)
    expect(t.consume).not.toHaveBeenCalled()
  })
  it('rechecks the source lease after consuming provenance', async () => {
    const t = await setup(); t.state.afterConsume = () => { t.state.sourceAllowed = false }
    const response = await t.call()
    expect(response.isError).toBe(true)
    expect((response.content as { type: string }[]).some(block => block.type === 'image')).toBe(false)
  })
  it('keeps the source lease until the final HTTP response continuation', async () => {
    const t = await setup(); t.state.afterConsume = () => { queueMicrotask(() => { t.state.sourceAllowed = false }) }
    const response = await t.call()
    expect(response.isError).toBe(true)
    expect((response.content as { type: string }[]).some(block => block.type === 'image')).toBe(false)
  })
  it.each([['image', PNG], ['text', Buffer.from('private source text\n')]] as const)
    ('rechecks %s after the application returned and before HTTP serializes it', async (_kind, bytes) => {
      const t = await setup(bytes), original = t.app.read.bind(t.app)
      vi.spyOn(t.app, 'read').mockImplementation(async (...args) => {
        const result = await original(...args)
        queueMicrotask(() => { t.state.sourceAllowed = false })
        return result
      })
      const response = await t.call()
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response.content)).not.toContain(bytes.toString('base64'))
      expect(JSON.stringify(response.content)).not.toContain('private source text')
    })
  it.each(['list', 'search'] as const)('holds the same source lease for %s results', async operation => {
    const t = await setup(Buffer.from('private searchable source\n'))
    t.state.afterConsume = () => { queueMicrotask(() => { t.state.sourceAllowed = false }) }
    const response = await t.client.callTool({ name: operation === 'list' ? 'friday_list_files' : 'friday_search_files', arguments: operation === 'list' ? {} :
      { files: [{ fileId: t.fixture.fileId, expectedDigest: t.fixture.digest }], query: 'source' } })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).not.toContain('private searchable source')
  })
  it('does not send bytes whose on-disk digest changed during authorization', async () => {
    const t = await setup()
    t.state.beforeAuthorize = async () => { writeFileSync(join(t.home, 'content', 'blobs', t.fixture.digest), Buffer.alloc(PNG.length, 1)) }
    const response = await t.call()
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('content_changed')
    expect(t.consume).not.toHaveBeenCalled()
  })
  it('rejects stale digests and caller-supplied identity or paths before authorizing bytes', async () => {
    const t = await setup()
    for (const patch of [{ expectedDigest: 'b'.repeat(64) }, { path: '/tmp/unmanaged.png' }, { provenance: t.provenance }, { runId: 'run-new' }]) {
      expect((await t.call(patch)).isError).toBe(true)
    }
    expect(t.authorize).not.toHaveBeenCalled(); expect(t.consume).not.toHaveBeenCalled()
  })
})
