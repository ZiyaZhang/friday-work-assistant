import { ExecutionMaterialError, materialProvenanceCovers, type ExecutionMaterials, type MaterialContext, type MaterialMetadata,
  type MaterialProvenance, type MaterialReceipt } from './execution-materials.js'
import { attachmentMediaType } from './execution-attachments.js'
import type { ToolDeliveryResult } from './tool-delivery.js'
import { createManagedZip, extractManagedZip, inspectManagedZip, MATERIAL_ZIP_LIMITS, MaterialZipError, type MaterialZipCode } from './execution-material-zip.js'
import { createHash } from 'node:crypto'

export interface MaterialRun {
  context: MaterialContext
  snapshot(): MaterialProvenance
  authorize(provenance: MaterialProvenance): Promise<{ assertCurrent(): void }>
  consume(provenance: MaterialProvenance): void
  deliver(file: { data: Buffer; name: string; note?: string }, assertCurrent: () => void): Promise<ToolDeliveryResult>
}
export interface ExecutionMaterialApplicationDeps {
  files: ExecutionMaterials
  resolveRun(runId: string): MaterialRun
}
export interface MaterialHandle { fileId: string; expectedDigest: string }
export interface PublicMaterial { fileId: string; digest: string; version: number; name: string; size: number }
export class MaterialApplicationError extends Error {
  constructor(readonly code: ExecutionMaterialError['code'] | MaterialZipCode | 'denied' | 'context_changed' | 'delivery_unknown' | 'image_too_large', message?: string) {
    super(message ?? (code === 'image_too_large' ? '图片超过本次读取大小上限，未截断发送。请提供较小的原图。' : `本次文件操作未完成：${code}`))
    this.name = 'MaterialApplicationError'
  }
}

/** The public methods accept logical file handles, never caller-supplied identity or provenance. */
export class ExecutionMaterialApplication {
  private readonly readResultGuards = new WeakMap<object, () => void>()
  constructor(private readonly deps: ExecutionMaterialApplicationDeps) {}

  /** Host-only recheck after caller continuations, immediately before serializing a read result. */
  assertReadResult(result: unknown): void {
    if (result && typeof result === 'object') this.readResultGuards.get(result)?.()
  }

  private guarded<T extends object>(result: T, check: () => void): T {
    check()
    this.readResultGuards.set(result, check)
    return result
  }

  async list(runId: string, input: { limit?: number } = {}) {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), listed = this.deps.files.list(run.context, input)
      const files: PublicMaterial[] = [], guards: (() => void)[] = []
      // Fail the whole request on an unreadable item; this must never become a misleading empty list.
      for (const metadata of listed.items) {
        const context = await this.authorize(run, metadata.provenance)
        const read = this.deps.files.read(context, this.pin(metadata))
        run.consume(copy(metadata.provenance))
        guards.push(() => { context.assertCurrent(); this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version) })
        files.push(publicFile(read))
      }
      run.context.assertCurrent()
      for (const guard of guards) guard()
      return this.guarded({ files, limit: listed.limit, truncated: listed.truncated }, () => { run.context.assertCurrent(); for (const guard of guards) guard() })
    })
  }

  async read(runId: string, input: MaterialHandle & { startLine?: number; endLine?: number; maxBytes?: number }) {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), metadata = this.meta(run, input), context = await this.authorize(run, metadata.provenance)
      const guard = () => { context.assertCurrent(); this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version) }
      // Inspect only authorized, digest-verified bytes; names and stored media claims are not evidence.
      const actual = this.deps.files.read(context, this.pin(metadata)), mediaType = attachmentMediaType(actual.data)
      if (mediaType === 'application/zip') throw new MaterialApplicationError('not_text', '这是 ZIP 压缩包，请先列出成员，再解包需要读取的文件；压缩字节不是文本。')
      if (mediaType.startsWith('image/')) {
        const maxBytes = input.maxBytes ?? 1024 * 1024
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 || input.startLine !== undefined || input.endLine !== undefined) {
          throw new MaterialApplicationError('invalid_request')
        }
        if (actual.data.length > maxBytes) throw new MaterialApplicationError('image_too_large')
        run.consume(copy(metadata.provenance))
        context.assertCurrent()
        this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version)
        return this.guarded({ ...publicFile(actual), mediaType, truncated: false as const,
          image: { mimeType: mediaType, data: actual.data.toString('base64') } }, guard)
      }
      const result = this.deps.files.readText(context, { ...this.pin(metadata), startLine: input.startLine, endLine: input.endLine, maxBytes: input.maxBytes })
      run.consume(copy(metadata.provenance))
      this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version)
      return this.guarded({ ...publicFile(result), text: result.text, startLine: result.startLine, endLine: result.endLine,
        totalLines: result.totalLines, truncated: result.truncated, endLineComplete: result.endLineComplete }, guard)
    })
  }

  async search(runId: string, input: { files: MaterialHandle[]; query: string; limit?: number }) {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), metadata = input.files.map(file => this.meta(run, file)), contexts: MaterialContext[] = []
      for (const file of metadata) contexts.push(await this.authorize(run, file.provenance))
      const context: MaterialContext = { ...run.context, assertCurrent() { run.context.assertCurrent(); for (const item of contexts) item.assertCurrent() } }
      const result = this.deps.files.search(context, { files: metadata.map(file => this.pin(file)), query: input.query, limit: input.limit })
      for (const file of metadata) run.consume(copy(file.provenance))
      context.assertCurrent()
      for (const file of metadata) this.deps.files.metadata(context, file.fileId, file.digest, file.version)
      return this.guarded(result, () => { context.assertCurrent(); for (const file of metadata) this.deps.files.metadata(context, file.fileId, file.digest, file.version) })
    })
  }

  async zipList(runId: string, input: MaterialHandle & { offset?: number; limit?: number }) {
    return this.perform(async () => {
      input = copy(input)
      const offset = input.offset ?? 0, limit = input.limit ?? 100
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new MaterialApplicationError('invalid_request')
      const run = this.run(runId), metadata = this.meta(run, input), context = await this.authorize(run, metadata.provenance)
      const archive = this.deps.files.read(context, this.pin(metadata))
      const guard = () => { context.assertCurrent(); this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version) }
      const entries = await inspectManagedZip(archive.data, guard)
      guard()
      run.consume(copy(metadata.provenance))
      const nextOffset = offset + limit < entries.length ? offset + limit : null
      return this.guarded({ ...publicFile(archive), entries: entries.slice(offset, offset + limit), total: entries.length,
        offset, nextOffset, complete: nextOffset === null }, guard)
    })
  }

  async zipExtract(runId: string, input: MaterialHandle & { members: string[] }, operationKey: string) {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), metadata = this.meta(run, input), context = await this.authorize(run, metadata.provenance)
      const archive = this.deps.files.read(context, this.pin(metadata))
      const guard = () => { context.assertCurrent(); this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version) }
      const members = await extractManagedZip(archive.data, input.members, guard)
      guard()
      run.consume(copy(metadata.provenance))
      const registered = this.deps.files.registerArchiveMembers(context, members.map(member => ({
        operationKey: `zip-member:${createHash('sha256').update(JSON.stringify([operationKey, member.member])).digest('hex')}`,
        name: member.name, data: member.data, provenance: { ...copy(metadata.provenance),
          archiveMember: { fileId: metadata.fileId, digest: metadata.digest, version: metadata.version, member: member.member } },
      })))
      return this.guarded({ archive: publicFile(archive), files: registered.map((file, i) => ({ ...publicFile(file), member: members[i]!.member })) }, () => {
        guard()
        for (const file of registered) this.deps.files.metadata(context, file.fileId, file.digest, file.version)
      })
    })
  }

  async zipPack(runId: string, input: { name: string; files: (MaterialHandle & { member?: string })[] }, operationKey: string): Promise<PublicMaterial> {
    return this.perform(async () => {
      input = copy(input)
      if (!input.files.length || input.files.length > 100 || !input.name.toLowerCase().endsWith('.zip')) throw new MaterialApplicationError('invalid_request')
      const run = this.run(runId), metadata = input.files.map(file => this.meta(run, file)), contexts: MaterialContext[] = []
      if (metadata.reduce((sum, file) => sum + file.size, 0) > MATERIAL_ZIP_LIMITS.bytes) throw new MaterialZipError('archive_limit')
      for (const file of metadata) {
        if (file.kind !== 'artifact') throw new MaterialApplicationError('invalid_request')
        const context = await this.authorize(run, file.provenance)
        this.deps.files.metadata(context, file.fileId, file.digest, file.version)
        contexts.push(context)
        run.consume(copy(file.provenance))
      }
      const replay = this.deps.files.operationMetadata(run.context, operationKey)
      const files = metadata.map((file, i) => {
        const actual = this.deps.files.read(contexts[i]!, this.pin(file))
        return { name: input.files[i]!.member ?? actual.name, data: actual.data }
      })
      const snapshot = copy(run.snapshot()), expected = replay ? undefined : fingerprint(snapshot)
      if (!metadata.every(file => materialProvenanceCovers(snapshot, file.provenance))) throw new MaterialApplicationError('provenance_conflict')
      const provenance: MaterialProvenance = replay?.provenance ?? { ...snapshot,
        archiveInputs: metadata.map((file, i) => ({ fileId: file.fileId, digest: file.digest, version: file.version, member: files[i]!.name })) }
      const writeContext = await this.authorize(run, provenance, false)
      // The lineage fields do not change source authority. For a new artifact,
      // freeze the actual current source snapshot throughout compression.
      const guard = () => {
        writeContext.assertCurrent()
        if (expected !== undefined && fingerprint(run.snapshot()) !== expected) throw new MaterialApplicationError('context_changed')
        for (const [i, file] of metadata.entries()) {
          contexts[i]!.assertCurrent(); this.deps.files.metadata(contexts[i]!, file.fileId, file.digest, file.version)
        }
      }
      guard()
      const data = await createManagedZip(files, guard)
      guard()
      run.consume(copy(provenance))
      const context = { ...writeContext, assertCurrent: guard }
      const result = this.deps.files.write(context, { operationKey, name: input.name, data, provenance })
      return this.guarded(publicFile(result), () => { guard(); this.deps.files.metadata(context, result.fileId, result.digest, result.version) })
    })
  }

  async write(runId: string, input: { name: string; text: string }, operationKey: string): Promise<PublicMaterial> {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), replay = this.deps.files.operationMetadata(run.context, operationKey)
      const provenance = replay?.provenance ?? copy(run.snapshot())
      const context = await this.authorize(run, provenance, !replay)
      run.consume(copy(provenance))
      return publicFile(this.deps.files.write(context, { operationKey, name: input.name, data: Buffer.from(input.text), provenance }))
    })
  }

  async edit(runId: string, input: MaterialHandle & { edits: { oldText: string; newText: string }[] }, operationKey: string): Promise<PublicMaterial> {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), replay = this.deps.files.operationMetadata(run.context, operationKey)
      if (replay) {
        if (replay.version < 2) throw new MaterialApplicationError('operation_conflict')
        const context = await this.authorize(run, replay.provenance)
        run.consume(copy(replay.provenance))
        return publicFile(this.deps.files.edit(context, { fileId: input.fileId, expectedDigest: input.expectedDigest, expectedVersion: replay.version - 1,
          operationKey, edits: input.edits, provenance: replay.provenance }))
      }
      const metadata = this.meta(run, input), readContext = await this.authorize(run, metadata.provenance)
      this.deps.files.metadata(readContext, metadata.fileId, metadata.digest, metadata.version)
      run.consume(copy(metadata.provenance))
      const provenance = copy(run.snapshot()), writeContext = await this.authorize(run, provenance, true)
      const context = { ...writeContext, assertCurrent() { readContext.assertCurrent(); writeContext.assertCurrent() } }
      return publicFile(this.deps.files.edit(context, { ...this.pin(metadata), operationKey, edits: input.edits, provenance }))
    })
  }

  /** Host-only attachment/download admission; this method is not an MCP tool. */
  async register(runId: string, input: { name: string; data: Buffer; provenance: MaterialProvenance }, operationKey: string,
    assertCurrent: () => void = () => {}): Promise<PublicMaterial> {
    return this.perform(async () => {
      assertCurrent()
      input = { ...input, data: Buffer.from(input.data), provenance: copy(input.provenance) }
      const run = this.run(runId), data = input.data, replay = this.deps.files.operationMetadata(run.context, operationKey)
      const provenance = replay?.provenance ?? copy(input.provenance)
      assertCurrent()
      const authorized = await this.authorize(run, provenance)
      const context = { ...authorized, assertCurrent() { assertCurrent(); authorized.assertCurrent() } }
      context.assertCurrent()
      // Original source evidence is part of an import intent; it cannot silently change on retry.
      if (replay && fingerprint(input.provenance) !== fingerprint(replay.provenance)) throw new MaterialApplicationError('operation_conflict')
      run.consume(copy(provenance))
      return publicFile(this.deps.files.register(context, { operationKey, name: input.name, data, provenance }))
    })
  }

  async send(runId: string, input: MaterialHandle & { note?: string }) {
    return this.perform(async () => {
      input = copy(input)
      const run = this.run(runId), metadata = this.meta(run, input), context = await this.authorize(run, metadata.provenance)
      const file = this.deps.files.read(context, this.pin(metadata))
      run.consume(copy(metadata.provenance))
      const guard = () => { context.assertCurrent(); this.deps.files.metadata(context, metadata.fileId, metadata.digest, metadata.version) }
      guard()
      const result = await run.deliver({ data: file.data, name: file.name, note: input.note }, guard)
      guard()
      return { ...publicFile(file), status: result.delivery.status, messageId: result.delivery.remoteId,
        replayed: result.delivery.replayed, ...(result.noteStatus !== undefined ? { noteStatus: result.noteStatus } : {}) }
    })
  }

  private run(runId: string): MaterialRun {
    const run = this.deps.resolveRun(runId)
    if (run.context.runId !== runId) throw new MaterialApplicationError('denied')
    run.context.assertCurrent()
    return run
  }
  private meta(run: MaterialRun, input: MaterialHandle): MaterialMetadata {
    return this.deps.files.metadata(run.context, input.fileId, input.expectedDigest)
  }
  private pin(file: MaterialMetadata) { return { fileId: file.fileId, expectedDigest: file.digest, expectedVersion: file.version } }
  private async authorize(run: MaterialRun, provenance: MaterialProvenance, requireSnapshot = false): Promise<MaterialContext> {
    const captured = copy(provenance), snapshot = requireSnapshot ? fingerprint(captured) : undefined
    run.context.assertCurrent()
    const lease = await run.authorize(copy(captured))
    const context: MaterialContext = { ...run.context, assertCurrent() {
      run.context.assertCurrent()
      lease.assertCurrent()
      if (snapshot !== undefined && fingerprint(run.snapshot()) !== snapshot) throw new MaterialApplicationError('context_changed')
    } }
    context.assertCurrent()
    return context
  }
  private async perform<T>(fn: () => Promise<T>): Promise<T> {
    try { const result = await fn(); this.assertReadResult(result); return result }
    catch (error) {
      if (error instanceof MaterialApplicationError) throw error
      if (error instanceof MaterialZipError) throw new MaterialApplicationError(error.code, error.message)
      if (error instanceof ExecutionMaterialError) throw new MaterialApplicationError(error.code)
      if (error && typeof error === 'object' && 'code' in error && error.code === 'unknown') throw new MaterialApplicationError('delivery_unknown')
      throw new MaterialApplicationError('denied')
    }
  }
}

function publicFile(file: MaterialReceipt): PublicMaterial {
  return { fileId: file.fileId, digest: file.digest, version: file.version, name: file.name, size: file.size }
}
function copy<T>(value: T): T { return structuredClone(value) }
function fingerprint(value: MaterialProvenance): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
