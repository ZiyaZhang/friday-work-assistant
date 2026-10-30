import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionMaterials, type MaterialContext, type MaterialProvenance, type MaterialWrite } from '../src/core/execution-materials.js'
import { Registry } from '../src/core/registry.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-materials-')), database = join(home, 'db'), root = join(home, 'private')
  let db = new DatabaseSync(database), store = new ExecutionMaterials(db, root, { now: () => 1234 })
  cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
  const ctx: MaterialContext = { sessionKey: 'session-a', spaceId: 'space-a', generation: 'acp-generation-a', runId: 'run-a', assertCurrent() {} }
  store.openGeneration(ctx)
  const provenance: MaterialProvenance = { sources: { version: 1, acpSessionId: 'acp-a', spaceId: ctx.spaceId, chatId: 'chat-a',
    memoryScopes: ['space:space-a'], chats: [{ chatId: 'source-chat', spaceId: 'source-space' }],
    external: [{ kind: 'document', ref: 'synthetic-document' }], repositories: [], personalMemoryComplete: true,
    messageSources: [{ ref: 'synthetic-message', appId: 'app-a', tenantId: 'tenant-a', spaceId: 'source-space', chatId: 'source-chat',
      messageId: 'om-synthetic', readIdentity: { kind: 'user', openId: 'synthetic-alice' }, readAt: 1000, coverage: 'partial' }] },
    memoryRefs: [{ id: 17, revision: 2 }] }
  const input = (text = '第一行🙂\r\nsecond literal [a].\nlast', operationKey = 'host-op-a'): MaterialWrite => ({ operationKey,
    name: 'synthetic-session.jsonl', data: Buffer.from(text), provenance: structuredClone(provenance) })
  return { home, root, ctx, provenance, input, get db() { return db }, get store() { return store },
    reopen() { db.close(); db = new DatabaseSync(database); store = new ExecutionMaterials(db, root, { now: () => 2345 }) } }
}
const pin = (receipt: { fileId: string; digest: string }) => ({ fileId: receipt.fileId, expectedDigest: receipt.digest })
function rows(db: DatabaseSync, table: string) { return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() }

describe('managed execution material storage (synthetic SQLite and bytes, no platform or model)', () => {
  it('does not discard an original inbound or delivered receipt when editing a derived file', () => {
    const t = fixture()
    t.provenance.sources.inboundMaterials = [{ messageId: 'container', chatId: 'chat-a', actorOpenId: 'alice', digest: 'a'.repeat(64), complete: true }]
    t.provenance.sources.deliveredMessages = [{ ref: 'host-question', deliveryKey: 'question:one', messageId: 'sent-message', tenantId: 'tenant-a',
      appId: 'app-a', spaceId: 'space-a', chatId: 'chat-a', chatType: 'group', targetOpenId: 'alice', contentDigest: 'b'.repeat(64) }]
    const original = t.store.register(t.ctx, t.input('original'))
    for (const key of ['inboundMaterials', 'deliveredMessages'] as const) {
      const provenance = structuredClone(t.provenance); delete provenance.sources[key]
      expect(() => t.store.edit(t.ctx, { ...pin(original), operationKey: `omit-${key}`, edits: [{ oldText: 'original', newText: 'changed' }], provenance }))
        .toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    }
  })
  it('does not drop or replace exact conversation snapshots while editing registered bytes', () => {
    const t = fixture()
    const source = { kind: 'message' as const, appId: 'app-a', chatId: 'source-chat', spaceId: 'source-space',
      messageId: 'message-a', contentDigest: 'a'.repeat(64), readIdentity: { kind: 'user' as const, openId: 'alice', tenantId: 'tenant-a' } }
    t.provenance.sources.conversationReads = { complete: true, items: [source] }
    const original = t.store.register(t.ctx, t.input('original'))
    for (const items of [[], [{ ...source, contentDigest: 'b'.repeat(64) }]]) {
      const provenance = structuredClone(t.provenance)
      provenance.sources.conversationReads = { complete: true, items }
      expect(() => t.store.edit(t.ctx, { ...pin(original), operationKey: `drop-${items.length}`, edits: [{ oldText: 'original', newText: 'changed' }], provenance }))
        .toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    }
    const provenance = structuredClone(t.provenance)
    provenance.sources.conversationReads!.items.push({ ...source, contentDigest: 'b'.repeat(64) })
    const updated = t.store.edit(t.ctx, { ...pin(original), operationKey: 'append-proof', edits: [{ oldText: 'original', newText: 'changed' }], provenance })
    t.reopen()
    expect(t.store.metadata(t.ctx, updated.fileId, updated.digest).provenance.sources.conversationReads).toEqual(provenance.sources.conversationReads)
  })

  it.each([false, undefined])('never upgrades incomplete or legacy conversation provenance on edit (%s)', complete => {
    const t = fixture()
    if (complete !== undefined) t.provenance.sources.conversationReads = { complete, items: [] }
    const original = t.store.register(t.ctx, t.input('original'))
    const provenance = structuredClone(t.provenance)
    provenance.sources.conversationReads = { complete: true, items: [] }
    expect(() => t.store.edit(t.ctx, { ...pin(original), operationKey: 'upgrade', edits: [{ oldText: 'original', newText: 'changed' }], provenance }))
      .toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(1)
  })

  it('stores immutable bytes and detached complete provenance; host metadata does not expose a name or host path', () => {
    const t = fixture(), input = t.input(), original = Buffer.from(input.data), expected = structuredClone(input.provenance)
    const file = t.store.register(t.ctx, input)
    input.data.fill(0); input.provenance.sources.chats.length = 0; input.provenance.memoryRefs[0]!.revision = 99
    expect(file).toMatchObject({ kind: 'input', version: 1, size: original.length, digest: createHash('sha256').update(original).digest('hex'), provenance: expected })
    expect(t.store.read(t.ctx, pin(file)).data).toEqual(original)
    const list = t.store.list(t.ctx), metadata = t.store.metadata(t.ctx, file.fileId, file.digest)
    expect(list.items).toEqual([metadata]); expect(list.total).toBe(1); expect(list.truncated).toBe(false)
    expect(metadata).not.toHaveProperty('name'); expect(JSON.stringify(list)).not.toContain(input.name)
    expect(JSON.stringify(file)).not.toContain(t.root)
    metadata.provenance.sources.chats.length = 0
    const read = t.store.read(t.ctx, pin(file)); read.data.fill(0)
    expect(t.store.metadata(t.ctx, file.fileId, file.digest).provenance).toEqual(expected)
    expect(t.store.read(t.ctx, pin(file)).data).toEqual(original)
    expect(statSync(t.root).mode & 0o777).toBe(0o700)
    expect(statSync(join(t.root, 'blobs', file.digest)).mode & 0o777).toBe(0o600)
  })

  it('uses logical IDs, permitting same names without overwriting another registered input', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input('input')), b = t.store.write(t.ctx, t.input('artifact', 'write-b'))
    expect(a.fileId).not.toBe(b.fileId); expect(a.name).toBe(b.name); expect(b.kind).toBe('artifact')
    expect(t.store.read(t.ctx, pin(a)).data.toString()).toBe('input')
    expect(t.store.read(t.ctx, pin(b)).data.toString()).toBe('artifact')
    expect(t.store.list(t.ctx, { limit: 1 })).toMatchObject({ total: 2, truncated: true, limit: 1 })
  })

  it('edits the exact version with a CAS, preserving old evidence while old public reads fail', () => {
    const t = fixture(), a = t.store.write(t.ctx, t.input('hello Alice\n'))
    const edited = t.store.edit(t.ctx, { ...pin(a), operationKey: 'edit-a', edits: [{ oldText: 'Alice', newText: 'Guest' }], provenance: t.provenance })
    expect(edited).toMatchObject({ fileId: a.fileId, version: 2, name: a.name })
    expect(t.store.read(t.ctx, pin(edited)).data.toString()).toBe('hello Guest\n')
    expect(() => t.store.read(t.ctx, pin(a))).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => t.store.metadata(t.ctx, a.fileId, a.digest)).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    const before = rows(t.db, 'execution_material_versions')
    expect(() => t.store.edit(t.ctx, { ...pin(a), operationKey: 'stale-edit', edits: [{ oldText: 'Alice', newText: 'Other' }], provenance: t.provenance }))
      .toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(rows(t.db, 'execution_material_versions')).toEqual(before)
    expect(readFileSync(join(t.root, 'blobs', a.digest)).toString()).toBe('hello Alice\n')
    expect(t.store.list(t.ctx).items.map(item => item.version)).toEqual([2])
  })

  it('retries return the original receipt even after later edits, never roll back the current pointer, and reject a changed operation', () => {
    const t = fixture(), input = t.input('v1'), a = t.store.write(t.ctx, input)
    const edit = { ...pin(a), operationKey: 'edit-a', edits: [{ oldText: 'v1', newText: 'v2' }], provenance: t.provenance }
    const b = t.store.edit(t.ctx, edit)
    const c = t.store.edit(t.ctx, { ...pin(b), operationKey: 'edit-b', edits: [{ oldText: 'v2', newText: 'v3' }], provenance: t.provenance })
    t.reopen()
    const nextRun = { ...t.ctx, runId: 'run-next' }
    expect(t.store.write(nextRun, input)).toEqual(a)
    expect(t.store.edit(nextRun, edit)).toEqual(b)
    expect(t.store.read(nextRun, pin(c)).data.toString()).toBe('v3')
    expect(t.store.list(nextRun).items[0]?.version).toBe(3)
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(3)
    for (const changed of [{ ...input, data: Buffer.from('different') }, { ...input, name: 'other.txt' },
      { ...input, provenance: { ...input.provenance, memoryRefs: [] } }]) {
      expect(() => t.store.write(nextRun, changed)).toThrow(expect.objectContaining({ code: 'operation_conflict' }))
    }
    expect(() => t.store.register(nextRun, input)).toThrow(expect.objectContaining({ code: 'operation_conflict' }))
    expect(() => t.store.edit(nextRun, { ...edit, edits: [{ oldText: 'v1', newText: 'different' }] }))
      .toThrow(expect.objectContaining({ code: 'operation_conflict' }))
  })

  it('pins provenance versions across async authorization even if bytes return to the same digest', () => {
    const t = fixture(), a = t.store.write(t.ctx, t.input('A'))
    const authorized = t.store.metadata(t.ctx, a.fileId, a.digest)
    const provenance = structuredClone(t.provenance); provenance.sources.repositories.push('test-org/new-source')
    const b = t.store.edit(t.ctx, { ...pin(a), expectedVersion: a.version, operationKey: 'to-b', edits: [{ oldText: 'A', newText: 'B' }], provenance })
    const c = t.store.edit(t.ctx, { ...pin(b), expectedVersion: b.version, operationKey: 'back-to-a', edits: [{ oldText: 'B', newText: 'A' }], provenance })
    expect(c.digest).toBe(a.digest); expect(c.version).toBe(3)
    const stalePin = { ...pin(a), expectedVersion: authorized.version }
    expect(() => t.store.read(t.ctx, stalePin)).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => t.store.readText(t.ctx, stalePin)).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => t.store.search(t.ctx, { files: [stalePin], query: 'A' })).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => t.store.edit(t.ctx, { ...stalePin, operationKey: 'unauthorized-edit', edits: [{ oldText: 'A', newText: 'D' }], provenance }))
      .toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(t.store.metadata(t.ctx, c.fileId, c.digest).provenance.sources.repositories).toEqual(['test-org/new-source'])
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(3)
  })

  it('rejects zero or ambiguous literal replacements and refuses to discard old sources or memory refs', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input('repeat repeat'))
    const edits = [{ oldText: 'repeat', newText: 'one' }]
    for (const oldText of ['absent', 'repeat']) expect(() => t.store.edit(t.ctx, { ...pin(a), operationKey: oldText,
      edits: [{ oldText, newText: 'replacement' }], provenance: t.provenance })).toThrow(expect.objectContaining({ code: 'edit_conflict' }))
    for (const change of ['refs', 'chats', 'messages', 'document', 'scope'] as const) {
      const provenance = structuredClone(t.provenance)
      if (change === 'refs') provenance.memoryRefs = []
      if (change === 'chats') provenance.sources.chats = []
      if (change === 'messages') provenance.sources.messageSources = []
      if (change === 'document') provenance.sources.external = []
      if (change === 'scope') provenance.sources.memoryScopes = []
      expect(() => t.store.edit(t.ctx, { ...pin(a), operationKey: change, edits, provenance })).toThrow(expect.objectContaining({ code: 'provenance_conflict' }))
    }
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(1)
    const provenance = structuredClone(t.provenance); provenance.sources.repositories.push('test-org/test-repo')
    const b = t.store.edit(t.ctx, { ...pin(a), operationKey: 'valid', edits: [{ oldText: 'repeat repeat', newText: 'new' }], provenance })
    expect(b.provenance.sources.repositories).toEqual(['test-org/test-repo'])
    expect(b.provenance.memoryRefs).toEqual(t.provenance.memoryRefs)
  })

  it('keeps generation invalidation after restart, cannot revive old IDs, and does not import old files into the replacement', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input())
    t.store.invalidateGeneration(t.ctx, 'memory_changed')
    const snapshot = rows(t.db, 'execution_material_generations')
    t.store.invalidateGeneration(t.ctx, 'repeat-does-not-rewrite-reason')
    expect(rows(t.db, 'execution_material_generations')).toEqual(snapshot)
    t.reopen()
    for (const action of [() => t.store.list(t.ctx), () => t.store.read(t.ctx, pin(a)), () => t.store.openGeneration(t.ctx),
      () => t.store.register(t.ctx, t.input())]) expect(action).toThrow(expect.objectContaining({ code: 'generation_invalid' }))
    const next = { ...t.ctx, generation: 'fresh-generation', runId: 'new-run' }
    t.store.openGeneration(next)
    expect(t.store.list(next).items).toEqual([])
    expect(() => t.store.read(next, pin(a))).toThrow(expect.objectContaining({ code: 'not_found' }))
    const b = t.store.register(next, t.input())
    expect(b.fileId).not.toBe(a.fileId)
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(2)
    expect(readFileSync(join(t.root, 'blobs', a.digest)).length).toBe(a.size)
  })

  it('opening a new generation disables the prior one but leaves another session independent; wrong bindings cannot list or read', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input())
    const other = { ...t.ctx, sessionKey: 'session-b', generation: 'other', runId: 'other-run' }
    t.store.openGeneration(other)
    const b = t.store.register(other, t.input('other-session'))
    const next = { ...t.ctx, generation: 'next' }; t.store.openGeneration(next)
    expect(() => t.store.list(t.ctx)).toThrow(expect.objectContaining({ code: 'generation_invalid' }))
    expect(t.store.read(other, pin(b)).data.toString()).toBe('other-session')
    expect(() => t.store.read(other, pin(a))).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => t.store.list({ ...other, spaceId: 'space-b' })).toThrow(expect.objectContaining({ code: 'binding_conflict' }))
    expect(() => t.store.openGeneration({ ...other, spaceId: 'space-b' })).toThrow(expect.objectContaining({ code: 'binding_conflict' }))
    expect(() => t.store.openGeneration({ ...other, spaceId: 'space-b', generation: 'different-space-generation' }))
      .toThrow(expect.objectContaining({ code: 'binding_conflict' }))
  })

  it('does not carry a prior process guard through reopen or allow an old Run after authorization changes', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input())
    expect(t.store.metadata(t.ctx, a.fileId, a.digest).provenance.memoryRefs).toEqual(t.provenance.memoryRefs)
    t.reopen()
    const stopped = { ...t.ctx, assertCurrent() { throw new Error('stopped') } }
    for (const action of [() => t.store.list(stopped), () => t.store.read(stopped, pin(a)),
      () => t.store.metadata(stopped, a.fileId, a.digest), () => t.store.search(stopped, { files: [pin(a)], query: 'literal' }),
      () => t.store.write(stopped, t.input('write', 'stopped')), () => t.store.openGeneration(stopped),
      () => t.store.invalidateGeneration(stopped, 'x')]) expect(action).toThrow('stopped')
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(1)
  })

  it.each([2, 3])('a guard rejection at write checkpoint %i rolls back all published metadata and leaves a retry available', checkpoint => {
    const t = fixture(); let calls = 0
    const revoked = { ...t.ctx, assertCurrent() { if (++calls === checkpoint) throw new Error('lease revoked') } }
    expect(() => t.store.write(revoked, t.input('staged bytes'))).toThrow('lease revoked')
    expect(t.store.list(t.ctx).total).toBe(0)
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(0)
    expect(rows(t.db, 'execution_material_files')).toHaveLength(0)
    expect(readdirSync(join(t.root, 'blobs')).some(name => name.startsWith('.staging-'))).toBe(false)
    expect(t.store.write(t.ctx, t.input('staged bytes')).version).toBe(1)
  })

  it('checks again before returning bytes and observes generation invalidation between metadata and read', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input()); let calls = 0
    expect(() => t.store.read({ ...t.ctx, assertCurrent() { if (++calls === 2) throw new Error('revoked after read') } }, pin(a))).toThrow('revoked after read')
    t.store.metadata(t.ctx, a.fileId, a.digest)
    t.store.openGeneration({ ...t.ctx, generation: 'after-await' })
    expect(() => t.store.read(t.ctx, pin(a))).toThrow(expect.objectContaining({ code: 'generation_invalid' }))
  })

  it('keeps UTF-8 and CRLF text ranges exact, reports partial coverage, and literal search does not interpret a regex', () => {
    const t = fixture(), a = t.store.register(t.ctx, t.input('第一行🙂\r\n[a]. here\n[a]. again\nlast'))
    const range = t.store.readText(t.ctx, { ...pin(a), startLine: 2, endLine: 3 })
    expect(range).toMatchObject({ text: '[a]. here\n[a]. again\n', startLine: 2, endLine: 3, totalLines: 4, truncated: true, endLineComplete: true })
    const short = t.store.readText(t.ctx, { ...pin(a), startLine: 1, endLine: 1, maxBytes: 10 })
    expect(short.text).toBe('第一行'); expect(short.endLineComplete).toBe(false); expect(short.truncated).toBe(true)
    expect(t.store.search(t.ctx, { files: [pin(a)], query: '[a].', limit: 1 })).toMatchObject({ total: 2, truncated: true,
      matches: [{ fileId: a.fileId, digest: a.digest, line: 2, column: 1, text: '[a]. here\n' }] })
    expect(t.store.search(t.ctx, { files: [pin(a)], query: '.*' }).matches).toEqual([])
    expect(t.store.readText(t.ctx, { ...pin(a), startLine: 99 })).toMatchObject({ text: '', endLine: 98, totalLines: 4, truncated: true })
  })

  it('preserves binary bytes but does not invent text or return a partially authorized search result', () => {
    const t = fixture(), input = t.input(); input.data = Buffer.from([0xff, 0, 0xfe])
    const binary = t.store.register(t.ctx, input), text = t.store.write(t.ctx, t.input('match', 'text'))
    expect(t.store.read(t.ctx, pin(binary)).data).toEqual(input.data)
    expect(() => t.store.readText(t.ctx, pin(binary))).toThrow(expect.objectContaining({ code: 'not_text' }))
    expect(() => t.store.search(t.ctx, { files: [pin(text), pin(binary)], query: 'match' })).toThrow(expect.objectContaining({ code: 'not_text' }))
    expect(() => t.store.search(t.ctx, { files: [pin(text), pin(text)], query: 'match' })).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  })

  it.each(['bytes', 'blob-symlink', 'directory-symlink', 'root-symlink'])('rejects %s tampering even when symlink targets contain the original bytes', mutation => {
    const t = fixture(), a = t.store.register(t.ctx, t.input()), blob = join(t.root, 'blobs', a.digest)
    if (mutation === 'bytes') writeFileSync(blob, 'tampered')
    else {
      const target = mutation === 'blob-symlink' ? blob : mutation === 'directory-symlink' ? join(t.root, 'blobs') : t.root
      const moved = join(t.home, 'moved-original'); renameSync(target, moved); symlinkSync(moved, target)
    }
    expect(() => t.store.read(t.ctx, pin(a))).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(() => t.store.register(t.ctx, t.input())).toThrow(expect.objectContaining({ code: 'content_changed' }))
    if (mutation.includes('directory') || mutation === 'root-symlink') {
      expect(() => new ExecutionMaterials(t.db, t.root)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    }
  })

  it('does not overwrite an existing corrupt content-addressed blob or publish a version pointing at it', () => {
    const t = fixture(), input = t.input(), digest = createHash('sha256').update(input.data).digest('hex')
    writeFileSync(join(t.root, 'blobs', digest), 'corruption')
    expect(() => t.store.write(t.ctx, input)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(readFileSync(join(t.root, 'blobs', digest)).toString()).toBe('corruption')
    expect(t.store.list(t.ctx).total).toBe(0)
  })

  it.each(['../name', '/tmp/name', 'dir/name', 'dir\\name', '', '.', '..', 'a\0b'])('rejects a nonlogical file name %j with no metadata writes', name => {
    const t = fixture()
    expect(() => t.store.write(t.ctx, { ...t.input(), name })).toThrow(expect.objectContaining({ code: 'invalid_request' }))
    expect(t.store.list(t.ctx).total).toBe(0)
  })

  it('rolls back within an outer host transaction without erasing old immutable bytes', () => {
    const t = fixture(), a = t.store.write(t.ctx, t.input('before'))
    t.db.exec('BEGIN')
    t.store.edit(t.ctx, { ...pin(a), operationKey: 'outer-edit', edits: [{ oldText: 'before', newText: 'after' }], provenance: t.provenance })
    t.db.exec('ROLLBACK')
    expect(t.store.read(t.ctx, pin(a)).data.toString()).toBe('before')
    expect(rows(t.db, 'execution_material_versions')).toHaveLength(1)
    expect(t.store.edit(t.ctx, { ...pin(a), operationKey: 'outer-edit', edits: [{ oldText: 'before', newText: 'after' }], provenance: t.provenance }).version).toBe(2)
  })

  it('adds only its tables to a nonempty old business database, then reopens twice with all old columns, rows, IDs and material evidence unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'friday-materials-old-db-')), path = join(home, 'old.db'), root = join(home, 'content')
    let registry = new Registry(path)
    cleanup.push(() => { registry.close(); rmSync(home, { recursive: true, force: true }) })
    registry.createSession({ sessionKey: 'old-session', chatId: 'old-chat', chatType: 'group', cwd: home, requesterOpenId: 'synthetic-owner' })
    const task = registry.createTaskOnce({ sessionKey: 'old-session', messageId: 'old-original-id', prompt: '合成旧原文\r\n否定要求🙂', requesterOpenId: 'synthetic-owner' }).task
    registry.db.exec(`CREATE TABLE legacy_receipts(id INTEGER PRIMARY KEY, status TEXT, body TEXT);
      INSERT INTO legacy_receipts VALUES (71,'unknown','synthetic immutable receipt');`)
    const oldTables = registry.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const oldData = oldTables.map(row => ({ name: String(row.name), rows: rows(registry.db, String(row.name)), columns: registry.db.prepare(`PRAGMA table_info("${row.name}")`).all() }))
    const ctx: MaterialContext = { sessionKey: 'old-session', spaceId: 'space-old', generation: 'new-managed', runId: 'host-run', assertCurrent() {} }
    let store = new ExecutionMaterials(registry.db, root)
    store.openGeneration(ctx)
    const provenance: MaterialProvenance = { memoryRefs: [], sources: { version: 1, acpSessionId: 'new-acp', spaceId: ctx.spaceId,
      chatId: 'old-chat', memoryScopes: [], chats: [], external: [], repositories: [], personalMemoryComplete: false } }
    const input = { operationKey: 'new-import', name: 'synthetic.txt', data: Buffer.from('new explicitly registered material'), provenance }
    const receipt = store.register(ctx, input)
    const allSchema = registry.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()
    const materialRows = ['execution_material_generations', 'execution_material_files', 'execution_material_versions'].map(table => rows(registry.db, table))
    for (let i = 0; i < 2; i++) {
      registry.close(); registry = new Registry(path); store = new ExecutionMaterials(registry.db, root)
      expect(registry.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(allSchema)
      for (const before of oldData) {
        expect(rows(registry.db, before.name)).toEqual(before.rows)
        expect(registry.db.prepare(`PRAGMA table_info("${before.name}")`).all()).toEqual(before.columns)
      }
      expect(['execution_material_generations', 'execution_material_files', 'execution_material_versions'].map(table => rows(registry.db, table))).toEqual(materialRows)
      expect(store.register(ctx, input)).toEqual(receipt)
      expect(store.read(ctx, pin(receipt)).data).toEqual(input.data)
      expect(registry.getTask(task.id)?.prompt).toBe('合成旧原文\r\n否定要求🙂')
    }
    expect(registry.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files').get()!.n).toBe(1)
  })
})
