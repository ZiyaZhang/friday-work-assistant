import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance } from '../src/core/execution-materials.js'
import { ExecutionMaterialApplication } from '../src/core/execution-material-application.js'
import { ToolDeliveryService } from '../src/core/tool-delivery.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function setup(options: { disabled?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-material-protocol-')), registry = new Registry(join(home, 'db'))
  const memory = new ChannelMemory(registry.db), memoryHost = memoryRuntimeFixture(registry, memory), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  registry.createSession({ sessionKey: 'session-a', chatId: 'chat-a', chatType: 'group', cwd: home, requesterOpenId: 'alice' })
  memoryHost.pin({ runId: 'run-a', sessionKey: 'session-a', actorOpenId: 'alice' })
  const state = { runId: 'run-a', actor: 'alice', stage: 'task', routes: undefined as string[] | undefined,
    beforeAuthorize: undefined as undefined | (() => Promise<void>), denied: false }
  const context: MaterialContext = { runId: 'run-a', sessionKey: 'session-a', spaceId: space.id, generation: 'generation-a',
    assertCurrent() { if (state.runId !== 'run-a' || state.actor !== 'alice') throw new Error('synthetic stopped') } }
  const provenance: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: space.id, chatId: 'chat-a',
    memoryScopes: [], chats: [], external: [], repositories: [], messageSources: [], personalMemoryComplete: true }, memoryRefs: [] }
  const files = new ExecutionMaterials(registry.db, join(home, 'content')); files.openGeneration(context)
  const fixture = files.register(context, { operationKey: 'host-import', name: 'synthetic.log',
    data: Buffer.from('request started\nrequest timeout\nclient spinning\n'), provenance })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('material-protocol', 'error')
  let consumed = 0, resolved = 0
  const app = new ExecutionMaterialApplication({ files, resolveRun: runId => {
    resolved++
    if (runId !== state.runId) throw new Error('old run')
    return { context, snapshot: () => structuredClone(provenance), async authorize() {
      await state.beforeAuthorize?.(); return { assertCurrent() { if (state.denied) throw new Error('private denied source') } }
    }, consume() { consumed++ }, async deliver(input, guard) {
      const service = new ToolDeliveryService(registry.db, { ...sp, feishu, contextRef: 'task:7:session:a', keyPrefix: 'task:7',
        assertCurrent: guard, resolveContext: async () => ({ actorOpenId: 'alice', expiresAt: Date.now() + 60_000, provenanceComplete: true,
          sources: [{ ref: 'synthetic-original', spaceId: space.id, chatId: 'chat-a' }],
          audience: { kind: 'group', spaceId: space.id, chatId: 'chat-a', replyToMessageId: 'original' } }) })
      return service.send({ kind: 'file', ...input })
    } }
  } })
  const tokens = new TokenIssuer('synthetic-secret'), cap: Capability = { sessionKey: 'session-a', runId: 'run-a', requesterOpenId: 'alice',
    chatId: 'chat-a', chatType: 'group', spaceId: space.id, cwd: home, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, ...sp, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10,
    materials: options.disabled ? undefined : app,
    resolveActorForSession: () => ({ requesterOpenId: state.actor, runId: state.runId, stage: state.stage }),
    allowedRoutesForSession: () => state.routes })
  await new Promise<void>(done => api.server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanup.push(async () => { await new Promise<void>(done => api.server.close(() => done())); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const post = (operation: string, body: Record<string, unknown>, override: Partial<Capability> = {}) => fetch(`${base}/v1/files/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const server = buildServer({ apiUrl: base, token: tokens.issue(cap) }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'material-protocol', version: '1' }); await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return JSON.parse((result.content as { type: string; text: string }[])[0]!.text)
  }
  return { app, files, context, provenance, fixture, home, registry, fake, state, cap, space, client, call, post,
    get consumed() { return consumed }, get resolved() { return resolved } }
}
const pin = (file: { fileId: string; digest: string }) => ({ fileId: file.fileId, expectedDigest: file.digest })

describe('real material MCP → HTTP → application → SQLite/Delivery (no model or external platform)', () => {
  it('supports the complete tool sequence with real bytes, versions, stable retry IDs and one delivery', async () => {
    const t = await setup(), list = await t.call('friday_list_files')
    expect(list.files).toMatchObject([{ fileId: t.fixture.fileId, name: 'synthetic.log' }])
    const read = await t.call('friday_read_file', { ...pin(t.fixture), startLine: 2, endLine: 2 })
    expect(read).toMatchObject({ text: 'request timeout\n', totalLines: 3, truncated: true })
    const search = await t.call('friday_search_files', { files: [pin(t.fixture)], query: 'timeout' })
    expect(search).toMatchObject({ matches: [{ line: 2, text: 'request timeout\n' }], total: 1 })
    const input = { name: 'summary.txt', text: 'Observed timeout; cause unknown.' }
    const a = await t.call('friday_write_file', input), retry = await t.call('friday_write_file', input)
    expect(retry).toEqual(a)
    const edit = { ...pin(a), edits: [{ oldText: 'cause unknown', newText: 'root cause not established' }] }
    const b = await t.call('friday_edit_file', edit)
    expect(b.fileId).toBe(a.fileId); expect(b.version).toBe(2); expect(b.digest).not.toBe(a.digest)
    expect(await t.call('friday_edit_file', edit)).toEqual(b)
    expect(t.files.read(t.context, { ...pin(b), expectedVersion: b.version }).data.toString()).toBe('Observed timeout; root cause not established.')
    const sent = await t.call('friday_send_material', pin(b))
    expect(sent).toMatchObject({ fileId: b.fileId, status: 'sent', messageId: expect.any(String) })
    expect(await t.call('friday_send_material', pin(b))).toMatchObject({ messageId: sent.messageId, replayed: true })
    expect(t.fake.sent.filter(item => item.kind === 'replyFile')).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()!.n).toBe(2)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n).toBe(3)
    expect(t.consumed).toBeGreaterThan(0)
    expect(JSON.stringify([list, read, search, a, b, sent])).not.toContain(t.home)
    expect(JSON.stringify([list, read, search, a, b, sent])).not.toMatch(/provenance|originRunId|spaceId|sessionKey|generation/)
  })

  it.each(['actor', 'spaceId', 'generation', 'expectedVersion', 'provenance', 'operationKey', 'path'])('rejects model-injected %s at both HTTP and MCP with no new version', async key => {
    const t = await setup(), input = { name: 'must-not-write.txt', text: 'not authorized by injected fields', [key]: 'forged' }
    expect((await t.post('write', input)).status).toBe(400)
    const result = await t.client.callTool({ name: 'friday_write_file', arguments: input })
    expect(result.isError).toBe(true)
    expect(t.registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_versions').get()!.n).toBe(1)
    expect(t.fake.sent).toEqual([])
  })

  it('rejects injected nested search provenance and edit control fields before any application call', async () => {
    const t = await setup()
    for (const [tool, operation, input] of [
      ['friday_search_files', 'search', { files: [{ ...pin(t.fixture), expectedVersion: 1 }], query: 'timeout' }],
      ['friday_edit_file', 'edit', { ...pin(t.fixture), edits: [{ oldText: 'timeout', newText: 'success', provenance: {} }] }],
    ] as const) {
      expect((await t.post(operation, input)).status).toBe(400)
      expect((await t.client.callTool({ name: tool, arguments: input })).isError).toBe(true)
    }
    expect(t.resolved).toBe(0)
  })

  it('rejects absent/old Run, changed actor/Space, missing scope and a phase allowlist without invoking material storage', async () => {
    const t = await setup()
    for (const override of [{ runId: undefined }, { runId: 'old-run' }, { requesterOpenId: 'other-user' }, { spaceId: 'another-space' }, { scopes: [] }]) {
      expect((await t.post('list', {}, override)).status).toBe(403)
    }
    t.state.stage = 'reflect'; t.state.routes = ['POST /v1/memory/search']
    expect((await t.post('read', pin(t.fixture))).status).toBe(403)
    expect((await t.client.callTool({ name: 'friday_list_files', arguments: {} })).isError).toBe(true)
    t.state.routes = undefined
    expect((await t.post('list', {}, { memoryWritePolicy: { candidateIds: [] } })).status).toBe(403)
    expect(t.resolved).toBe(0)
  })

  it('does not borrow a new Run after an in-flight request authorization, and returns no material text', async () => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = t.post('read', pin(t.fixture)); await entered.promise
    t.state.runId = 'new-run'; release.resolve()
    const result = await pending
    expect(result.status).toBe(403)
    expect(JSON.stringify(await result.json())).not.toContain('request timeout')
  })

  it('pins metadata across HTTP authorization await and rejects same-digest changed provenance', async () => {
    const t = await setup(), entered = deferred(), release = deferred()
    t.state.beforeAuthorize = async () => { entered.resolve(); await release.promise }
    const pending = t.post('read', pin(t.fixture)); await entered.promise
    const provenance = structuredClone(t.provenance); provenance.sources.repositories.push('private/added')
    t.files.edit(t.context, { ...pin(t.fixture), operationKey: 'host-new-source',
      edits: [{ oldText: 'request timeout', newText: 'request timeout' }], provenance })
    release.resolve(); const result = await pending
    expect(result.status).toBe(409)
    expect(JSON.stringify(await result.json())).not.toContain('request timeout')
  })

  it('rejects an invalidated generation and source denial without claiming an empty list', async () => {
    const t = await setup()
    t.state.denied = true
    const denied = await t.post('list', {})
    expect(denied.status).toBe(403); expect(await denied.json()).not.toHaveProperty('files')
    t.state.denied = false; t.files.invalidateGeneration(t.context, 'memory_changed')
    expect((await t.post('read', pin(t.fixture))).status).toBe(409)
    expect(t.fake.sent).toEqual([])
  })

  it('a valid current token cannot read another session material even with its real ID and digest', async () => {
    const t = await setup(), context = { ...t.context, sessionKey: 'other-session', generation: 'other-generation', runId: 'other-run' }
    t.files.openGeneration(context)
    const other = t.files.register(context, { operationKey: 'other-import', name: 'PRIVATE_OTHER_NAME.txt',
      data: Buffer.from('PRIVATE_OTHER_BODY'), provenance: t.provenance })
    const result = await t.post('read', pin(other))
    expect(result.status).toBe(404)
    expect(JSON.stringify(await result.json())).not.toMatch(/PRIVATE_OTHER_NAME|PRIVATE_OTHER_BODY/)
    expect(JSON.stringify(await t.call('friday_list_files'))).not.toContain(other.fileId)
  })

  it('an unconfigured application cannot fall back to a path even when the signed business cwd contains that file', async () => {
    const t = await setup({ disabled: true }), path = join(t.home, 'legacy.txt')
    writeFileSync(path, 'PRIVATE_LEGACY_BYTES')
    const result = await t.post('read', { path })
    expect(result.status).toBe(503)
    expect(JSON.stringify(await result.json())).not.toContain('PRIVATE_LEGACY_BYTES')
    expect((await t.client.callTool({ name: 'friday_send_material', arguments: pin(t.fixture) })).isError).toBe(true)
    expect(t.resolved).toBe(0); expect(t.fake.sent).toEqual([])
  })
})
