import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SourceContext } from './source-context.js'
import type { RuntimeMemoryRef } from './runtime-contexts.js'
import { validConversationReads } from './conversation-read-source.js'

/** Host inputs only. Neither a generation nor provenance is an authorization grant. */
export interface MaterialContext {
  sessionKey: string
  spaceId: string
  generation: string
  runId: string
  assertCurrent(): void
}
export interface MaterialProvenance {
  sources: SourceContext
  memoryRefs: RuntimeMemoryRef[]
  /** Host-attested relation between admitted bytes and the exact human-supplied message/container. */
  attachment?: { containerMessageId: string; resourceMessageId: string; chatId: string; actorOpenId: string;
    resourceType: 'file' | 'image'; keyDigest: string; contentDigest: string; mediaType: string }
  /** Transformation lineage only. Original attachment evidence still describes the
   * admitted archive bytes; it does not claim its digest equals a child's bytes. */
  archiveMember?: { fileId: string; digest: string; version: number; member: string }
  archiveInputs?: { fileId: string; digest: string; version: number; member: string }[]
}
export interface MaterialMetadata {
  fileId: string
  sessionKey: string
  spaceId: string
  generation: string
  originRunId: string
  kind: 'input' | 'artifact'
  version: number
  digest: string
  size: number
  createdAt: number
  provenance: MaterialProvenance
}
export interface MaterialReceipt extends MaterialMetadata { name: string }
export interface MaterialWrite { operationKey: string; name: string; data: Buffer; provenance: MaterialProvenance }
export interface MaterialVersion {
  fileId: string
  expectedDigest: string
  /** Host pin from metadata before async authorization, never a model-supplied authority. */
  expectedVersion?: number
}
export interface MaterialEdit extends MaterialVersion {
  operationKey: string
  edits: { oldText: string; newText: string }[]
  provenance: MaterialProvenance
}
export class ExecutionMaterialError extends Error {
  constructor(readonly code: 'invalid_request' | 'generation_invalid' | 'binding_conflict' | 'not_found'
    | 'version_conflict' | 'operation_conflict' | 'content_changed' | 'not_text' | 'edit_conflict' | 'provenance_conflict') {
    super(`受管文件不可用：${code}`)
    this.name = 'ExecutionMaterialError'
  }
}

type Row = Record<string, unknown>
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const DIGEST = /^[0-9a-f]{64}$/

/**
 * Immutable content storage, not an authorization service or an OS sandbox.
 * The application must authorize metadata before exposing even names, and register
 * actual consumption before returning bytes. All methods are synchronous so its
 * current-Run/lease guard surrounds each publish without an intervening await.
 */
export class ExecutionMaterials {
  private readonly root: string
  private readonly blobs: string
  constructor(private readonly db: DatabaseSync, privateRoot: string, private readonly options: { now?: () => number } = {}) {
    const requested = resolve(privateRoot)
    if (!existsSync(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 })
    if (!lstatSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) fail('content_changed')
    this.root = requested
    this.rootIdentity = realpathSync(requested)
    chmodSync(requested, 0o700)
    this.blobs = join(requested, 'blobs')
    if (!existsSync(this.blobs)) mkdirSync(this.blobs, { mode: 0o700 })
    this.checkDirectories()
    chmodSync(this.blobs, 0o700)
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_material_generations (
        session_key TEXT NOT NULL, generation TEXT NOT NULL, space_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','invalidated')),
        created_at INTEGER NOT NULL, invalidated_at INTEGER, reason TEXT,
        PRIMARY KEY(session_key,generation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_material_active
        ON execution_material_generations(session_key) WHERE state='active';
      CREATE TABLE IF NOT EXISTS execution_material_files (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, generation TEXT NOT NULL,
        space_id TEXT NOT NULL, current_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_material_files_generation
        ON execution_material_files(session_key,generation);
      CREATE TABLE IF NOT EXISTS execution_material_versions (
        file_id TEXT NOT NULL, version INTEGER NOT NULL, session_key TEXT NOT NULL, generation TEXT NOT NULL,
        origin_run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('input','artifact')),
        name TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL,
        provenance_json TEXT NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(file_id,version),
        UNIQUE(session_key,generation,operation_key)
      );
    `)
  }
  private readonly rootIdentity: string

  /** Only the host opens a new ACP-bound generation. Invalidated IDs never revive. */
  openGeneration(ctx: MaterialContext): void {
    this.checkContext(ctx)
    this.transaction(() => {
      const old = this.generation(ctx)
      if (old && old.space_id !== ctx.spaceId) fail('binding_conflict')
      if (old?.state === 'invalidated') fail('generation_invalid')
      if (this.db.prepare('SELECT 1 FROM execution_material_generations WHERE session_key=? AND space_id<>? LIMIT 1')
        .get(ctx.sessionKey, ctx.spaceId)) fail('binding_conflict')
      ctx.assertCurrent()
      if (old) { this.current(ctx); return }
      this.db.prepare(`UPDATE execution_material_generations SET state='invalidated',invalidated_at=?,reason='superseded'
        WHERE session_key=? AND state='active'`).run(this.now(), ctx.sessionKey)
      this.db.prepare(`INSERT INTO execution_material_generations(session_key,generation,space_id,state,created_at)
        VALUES (?,?,?,'active',?)`).run(ctx.sessionKey, ctx.generation, ctx.spaceId, this.now())
      this.current(ctx)
    })
  }

  invalidateGeneration(ctx: MaterialContext, reason: string): void {
    this.checkContext(ctx)
    if (!validId(reason)) fail('invalid_request')
    this.transaction(() => {
      const old = this.generation(ctx)
      if (!old) fail('generation_invalid')
      if (old.space_id !== ctx.spaceId) fail('binding_conflict')
      ctx.assertCurrent()
      this.db.prepare(`UPDATE execution_material_generations SET state='invalidated',invalidated_at=?,reason=?
        WHERE session_key=? AND generation=? AND state='active'`).run(this.now(), reason, ctx.sessionKey, ctx.generation)
    })
  }

  /** Host-only discovery: no file names or bytes before per-item source authorization. */
  list(ctx: MaterialContext, options: { limit?: number } = {}): { items: MaterialMetadata[]; total: number; truncated: boolean; limit: number } {
    this.current(ctx)
    const limit = bounded(options.limit ?? 100, 1, 500)
    const rows = this.db.prepare(`${this.currentSql()} WHERE f.session_key=? AND f.generation=? AND f.space_id=?
      ORDER BY v.created_at,f.id LIMIT ?`).all(ctx.sessionKey, ctx.generation, ctx.spaceId, limit)
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM execution_material_files WHERE session_key=? AND generation=? AND space_id=?')
      .get(ctx.sessionKey, ctx.generation, ctx.spaceId)!.n)
    this.current(ctx)
    return { items: rows.map(row => this.toMetadata(row)), total, limit, truncated: total > rows.length }
  }

  metadata(ctx: MaterialContext, fileId: string, expectedDigest: string, expectedVersion?: number): MaterialMetadata {
    this.current(ctx)
    const row = this.version(ctx, { fileId, expectedDigest, expectedVersion })
    this.current(ctx)
    this.version(ctx, { fileId, expectedDigest, expectedVersion: Number(row.version) })
    return this.toMetadata(row)
  }

  /** Host-only replay preflight. Authorize this original version before requesting its receipt. */
  operationMetadata(ctx: MaterialContext, operationKey: string): MaterialMetadata | undefined {
    this.current(ctx)
    if (!validId(operationKey)) fail('invalid_request')
    const row = this.db.prepare(`SELECT v.*,f.space_id FROM execution_material_versions v JOIN execution_material_files f ON f.id=v.file_id
      WHERE v.session_key=? AND v.generation=? AND v.operation_key=?`).get(ctx.sessionKey, ctx.generation, operationKey)
    this.current(ctx)
    return row ? this.toMetadata(row) : undefined
  }

  read(ctx: MaterialContext, input: MaterialVersion): MaterialReceipt & { data: Buffer } {
    this.current(ctx)
    const row = this.version(ctx, input), data = this.readBlob(String(row.digest), Number(row.size))
    this.current(ctx)
    this.version(ctx, { ...input, expectedVersion: Number(row.version) })
    return { ...this.toReceipt(row), data }
  }

  readText(ctx: MaterialContext, input: MaterialVersion & { startLine?: number; endLine?: number; maxBytes?: number }) {
    const read = this.read(ctx, input), lines = textLines(decode(read.data))
    const startLine = bounded(input.startLine ?? 1, 1, Number.MAX_SAFE_INTEGER)
    const endLine = bounded(input.endLine ?? startLine + 199, startLine, Number.MAX_SAFE_INTEGER)
    const maxBytes = bounded(input.maxBytes ?? 64 * 1024, 1, MAX_TEXT_BYTES)
    const requested = lines.slice(startLine - 1, endLine).join(''), bytes = Buffer.from(requested)
    // Streaming decode discards only an incomplete final UTF-8 sequence at the byte cap.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), { stream: bytes.length > maxBytes })
    const returnedLines = textLines(text).length
    this.current(ctx)
    this.version(ctx, { ...input, expectedVersion: read.version })
    const { data: _, ...receipt } = read
    return { ...receipt, text, startLine, endLine: returnedLines ? startLine + returnedLines - 1 : startLine - 1,
      totalLines: lines.length, truncated: startLine > 1 || endLine < lines.length || bytes.length > maxBytes,
      endLineComplete: bytes.length <= maxBytes || text.endsWith('\n') }
  }

  search(ctx: MaterialContext, input: { files: MaterialVersion[]; query: string; limit?: number }) {
    this.current(ctx)
    if (!Array.isArray(input.files) || input.files.length > 100 || !input.query || input.query.length > 4096
      || /[\r\n\0]/.test(input.query)) fail('invalid_request')
    const limit = bounded(input.limit ?? 50, 1, 500)
    const matches: { fileId: string; digest: string; line: number; column: number; text: string; textTruncated: boolean }[] = []
    const used = new Set<string>()
    const versions: MaterialVersion[] = []
    let total = 0
    for (const file of input.files) {
      if (used.has(file.fileId)) fail('invalid_request')
      used.add(file.fileId)
      const read = this.read(ctx, file), lines = textLines(decode(read.data))
      versions.push({ ...file, expectedVersion: read.version })
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!, column = line.indexOf(input.query)
        if (column < 0) continue
        total++
        if (matches.length < limit) {
          const from = Math.max(0, column - 120), snippet = line.slice(from, Math.max(from + 512, column + input.query.length))
          matches.push({ fileId: file.fileId, digest: file.expectedDigest, line: i + 1, column: column + 1,
            text: snippet, textTruncated: from > 0 || snippet.length < line.length })
        }
      }
    }
    this.current(ctx)
    for (const file of versions) this.version(ctx, file)
    return { matches, total, limit, truncated: total > matches.length }
  }

  register(ctx: MaterialContext, input: MaterialWrite): MaterialReceipt { return this.create(ctx, input, 'input') }
  /** ZIP outputs publish together only after all selected members have been checked. */
  registerArchiveMembers(ctx: MaterialContext, members: MaterialWrite[]): MaterialReceipt[] {
    if (!members.length || members.length > 100) fail('invalid_request')
    return this.transaction(() => members.map(input => this.create(ctx, input, 'input')))
  }
  write(ctx: MaterialContext, input: MaterialWrite): MaterialReceipt { return this.create(ctx, input, 'artifact') }

  edit(ctx: MaterialContext, input: MaterialEdit): MaterialReceipt {
    this.current(ctx)
    if (!validId(input.operationKey) || !Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100) fail('invalid_request')
    const edits = input.edits.map(edit => {
      if (typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') fail('invalid_request')
      return { oldText: edit.oldText, newText: edit.newText }
    })
    this.validateVersion(input)
    const provenance = this.provenance(ctx, input.provenance)
    const requestDigest = hash(Buffer.from(canonical({ operation: 'edit', fileId: input.fileId, expectedDigest: input.expectedDigest,
      expectedVersion: input.expectedVersion, edits, provenance })))
    const replay = this.replay(ctx, input.operationKey, requestDigest)
    if (replay) return replay
    const old = this.read(ctx, input)
    if (!covers(provenance, old.provenance)) fail('provenance_conflict')
    let text = decode(old.data)
    for (const edit of edits) {
      const at = text.indexOf(edit.oldText)
      if (at < 0 || text.indexOf(edit.oldText, at + 1) >= 0) fail('edit_conflict')
      text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length)
    }
    const data = Buffer.from(text)
    this.validateBytes(data)
    return this.publish(ctx, { fileId: old.fileId, version: old.version + 1, name: old.name, kind: 'artifact', data, provenance,
      operationKey: input.operationKey, requestDigest, previous: input })
  }

  private create(ctx: MaterialContext, input: MaterialWrite, kind: 'input' | 'artifact'): MaterialReceipt {
    this.current(ctx)
    if (!validId(input.operationKey) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255
      || /[\/\\\x00-\x1f\x7f]/.test(input.name) || input.name === '.' || input.name === '..') fail('invalid_request')
    this.validateBytes(input.data)
    const data = Buffer.from(input.data), provenance = this.provenance(ctx, input.provenance)
    const requestDigest = hash(Buffer.from(canonical({ operation: kind, name: input.name, digest: hash(data), provenance })))
    const replay = this.replay(ctx, input.operationKey, requestDigest)
    if (replay) return replay
    return this.publish(ctx, { fileId: randomUUID(), version: 1, name: input.name, kind, data, provenance, operationKey: input.operationKey, requestDigest })
  }

  private publish(ctx: MaterialContext, next: { fileId: string; version: number; name: string; kind: 'input' | 'artifact'; data: Buffer;
    provenance: MaterialProvenance; operationKey: string; requestDigest: string; previous?: MaterialVersion }): MaterialReceipt {
    const digest = hash(next.data)
    this.storeBlob(digest, next.data)
    return this.transaction(() => {
      this.current(ctx)
      const replay = this.replay(ctx, next.operationKey, next.requestDigest)
      if (replay) return replay
      if (next.previous) {
        const old = this.version(ctx, next.previous)
        if (Number(old.version) !== next.version - 1) fail('version_conflict')
        this.db.prepare('UPDATE execution_material_files SET current_version=? WHERE id=? AND current_version=?')
          .run(next.version, next.fileId, next.version - 1)
      } else {
        this.db.prepare('INSERT INTO execution_material_files(id,session_key,generation,space_id,current_version) VALUES (?,?,?,?,?)')
          .run(next.fileId, ctx.sessionKey, ctx.generation, ctx.spaceId, next.version)
      }
      this.db.prepare(`INSERT INTO execution_material_versions(file_id,version,session_key,generation,origin_run_id,kind,
        name,digest,size,provenance_json,operation_key,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(next.fileId, next.version, ctx.sessionKey, ctx.generation, ctx.runId, next.kind, next.name, digest, next.data.length,
          canonical(next.provenance), next.operationKey, next.requestDigest, this.now())
      this.current(ctx)
      this.version(ctx, { fileId: next.fileId, expectedDigest: digest })
      return this.toReceipt(this.db.prepare(`${this.currentSql()} WHERE f.id=?`).get(next.fileId)!)
    })
  }

  private replay(ctx: MaterialContext, operationKey: string, requestDigest: string): MaterialReceipt | undefined {
    const row = this.db.prepare(`SELECT v.*,f.space_id FROM execution_material_versions v JOIN execution_material_files f ON f.id=v.file_id
      WHERE v.session_key=? AND v.generation=? AND v.operation_key=?`).get(ctx.sessionKey, ctx.generation, operationKey)
    if (!row) return undefined
    if (row.request_digest !== requestDigest) fail('operation_conflict')
    this.readBlob(String(row.digest), Number(row.size))
    this.current(ctx)
    // This is the original operation receipt, not permission to read a superseded version.
    return this.toReceipt(row)
  }

  private version(ctx: MaterialContext, input: MaterialVersion): Row {
    this.validateVersion(input)
    const row = this.db.prepare(`${this.currentSql()} WHERE f.id=? AND f.session_key=? AND f.generation=? AND f.space_id=?`)
      .get(input.fileId, ctx.sessionKey, ctx.generation, ctx.spaceId)
    if (!row) fail('not_found')
    if (row.digest !== input.expectedDigest || (input.expectedVersion !== undefined && row.version !== input.expectedVersion)) fail('version_conflict')
    return row
  }
  private currentSql(): string { return 'SELECT v.*,f.space_id FROM execution_material_files f JOIN execution_material_versions v ON v.file_id=f.id AND v.version=f.current_version' }
  private generation(ctx: MaterialContext) { return this.db.prepare('SELECT * FROM execution_material_generations WHERE session_key=? AND generation=?').get(ctx.sessionKey, ctx.generation) }
  private checkContext(ctx: MaterialContext): void {
    if (![ctx.sessionKey, ctx.spaceId, ctx.generation, ctx.runId].every(validId) || typeof ctx.assertCurrent !== 'function') fail('invalid_request')
    ctx.assertCurrent()
  }
  private current(ctx: MaterialContext): void {
    this.checkContext(ctx)
    const row = this.generation(ctx)
    if (!row || row.state !== 'active') fail('generation_invalid')
    if (row.space_id !== ctx.spaceId) fail('binding_conflict')
  }
  private validateVersion(input: MaterialVersion): void {
    if (!validId(input.fileId) || !DIGEST.test(input.expectedDigest)
      || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))) fail('invalid_request')
  }
  private validateBytes(data: Buffer): void { if (!Buffer.isBuffer(data) || data.length > MAX_FILE_BYTES) fail('invalid_request') }
  private provenance(ctx: MaterialContext, value: MaterialProvenance): MaterialProvenance {
    const copy = JSON.parse(canonical(value)) as MaterialProvenance
    const source = copy?.sources
    if (!source || source.version !== 1 || source.spaceId !== ctx.spaceId || !validId(source.acpSessionId)
      || !validId(source.chatId) || !Array.isArray(source.memoryScopes) || !Array.isArray(source.chats)
      || !Array.isArray(source.external) || !Array.isArray(source.repositories) || !Array.isArray(copy.memoryRefs)
      || (source.conversationReads !== undefined && !validConversationReads(source.conversationReads))) fail('invalid_request')
    const refs = new Map<number, number>()
    for (const ref of copy.memoryRefs) {
      if (!Number.isSafeInteger(ref.id) || ref.id < 1 || !Number.isSafeInteger(ref.revision) || ref.revision < 1
        || (refs.has(ref.id) && refs.get(ref.id) !== ref.revision)) fail('invalid_request')
      refs.set(ref.id, ref.revision)
    }
    copy.memoryRefs = [...refs].sort(([a], [b]) => a - b).map(([id, revision]) => ({ id, revision }))
    return copy
  }
  private toMetadata(row: Row): MaterialMetadata {
    return { fileId: String(row.file_id), sessionKey: String(row.session_key), spaceId: String(row.space_id), generation: String(row.generation),
      originRunId: String(row.origin_run_id), kind: row.kind as 'input' | 'artifact', version: Number(row.version), digest: String(row.digest),
      size: Number(row.size), createdAt: Number(row.created_at), provenance: JSON.parse(String(row.provenance_json)) }
  }
  private toReceipt(row: Row): MaterialReceipt { return { ...this.toMetadata(row), name: String(row.name) } }
  private now(): number { return (this.options.now ?? Date.now)() }
  private transaction<T>(fn: () => T): T {
    const key = `materials_${randomUUID().replaceAll('-', '')}`
    this.db.exec(`SAVEPOINT ${key}`)
    try { const result = fn(); this.db.exec(`RELEASE ${key}`); return result }
    catch (error) { this.db.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw error }
  }

  private checkDirectories(): void {
    try {
      if (!lstatSync(this.root).isDirectory() || !lstatSync(this.blobs).isDirectory()
        || realpathSync(this.root) !== this.rootIdentity || realpathSync(this.blobs) !== join(this.rootIdentity, 'blobs')) fail('content_changed')
    } catch { fail('content_changed') }
  }
  private readBlob(digest: string, size: number): Buffer {
    if (!DIGEST.test(digest) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail('content_changed')
    this.checkDirectories()
    let fd: number | undefined
    try {
      fd = openSync(join(this.blobs, digest), constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== size) fail('content_changed')
      const data = readFileSync(fd)
      this.checkDirectories()
      if (data.length !== size || hash(data) !== digest) fail('content_changed')
      return data
    } catch { throw new ExecutionMaterialError('content_changed') }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  private storeBlob(digest: string, data: Buffer): void {
    this.checkDirectories()
    const destination = join(this.blobs, digest), staging = join(this.blobs, `.staging-${randomUUID()}`)
    let fd: number | undefined
    try {
      fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, data)
      closeSync(fd); fd = undefined
      this.checkDirectories()
      try { linkSync(staging, destination) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      this.readBlob(digest, data.length)
    } catch { fail('content_changed') }
    finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(staging) } catch { /* A crash may leave unreferenced staging; never a published material. */ }
    }
  }
}

function fail(code: ExecutionMaterialError['code']): never { throw new ExecutionMaterialError(code) }
function validId(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value) }
function bounded(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_request'); return value }
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }
function canonical(value: unknown): string {
  if (value === undefined) fail('invalid_request')
  try { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) }
  catch { fail('invalid_request') }
}
function decode(data: Buffer): string { try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); if (text.includes('\0')) fail('not_text'); return text } catch { fail('not_text') } }
function textLines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? [] }
function covers(next: MaterialProvenance, previous: MaterialProvenance): boolean {
  const subset = (a: unknown[], b: unknown[]) => { const allowed = new Set(b.map(canonical)); return a.every(item => allowed.has(canonical(item))) }
  return subset(previous.memoryRefs, next.memoryRefs)
    && subset(previous.sources.memoryScopes, next.sources.memoryScopes)
    && subset(previous.sources.chats, next.sources.chats)
    && subset(previous.sources.external, next.sources.external)
    && subset(previous.sources.repositories, next.sources.repositories)
    && subset(previous.sources.messageSources ?? [], next.sources.messageSources ?? [])
    && subset(previous.sources.inboundMaterials ?? [], next.sources.inboundMaterials ?? [])
    && subset(previous.sources.deliveredMessages ?? [], next.sources.deliveredMessages ?? [])
    && subset(previous.sources.myDaySources ?? [], next.sources.myDaySources ?? [])
    && subset(previous.sources.meetingSources ?? [], next.sources.meetingSources ?? [])
    && subset(previous.sources.pollSources ?? [], next.sources.pollSources ?? [])
    && (previous.sources.personalMemoryComplete === true || next.sources.personalMemoryComplete !== true)
    && subset(previous.sources.conversationReads?.items ?? [], next.sources.conversationReads?.items ?? [])
    && (previous.sources.conversationReads?.complete === true || next.sources.conversationReads?.complete !== true)
}
// Canonical renamed covers to materialProvenanceCovers; ZIP packing (execution-material-application.ts) and the meeting runtime tests import that name. Alias only.
export { covers as materialProvenanceCovers }
