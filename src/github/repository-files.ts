import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { attachmentMediaType } from '../core/execution-attachments.js'
import type { ChangeIdentity } from './changes.js'

/** Implemented by ChangeManager inside its existing publish/change lock. These
 * paths and guards are host facts; no MCP input can supply them. */
export interface RepositoryChangeLease {
  id: string
  repo: string
  dir: string
  assertCurrent(): void
  snapshot(): Promise<string>
  pathInventory(path: string): Promise<{ paths: string[]; complete: boolean }>
}
export interface RepositoryChangeBoundary {
  withChange<T>(input: RepositoryFileIdentity & { id: string }, use: (change: RepositoryChangeLease) => Promise<T>): Promise<T>
}
export interface RepositoryFileIdentity extends ChangeIdentity { assertAuthorized(): void }
export interface RepositoryFileAccess {
  action: 'read' | 'write'
  changeId: string
  repo: string
  path: string
  /** A write approval is bound to both the actual input tree and desired bytes. */
  expectedSnapshot?: string
  expectedDigest?: string | null
  contentDigest?: string | null
}
export interface RepositoryFilesDeps {
  changes: RepositoryChangeBoundary
  /** Reuses the caller's capability, source restrictions and Policy/Approvals.
   * Return only after any required human approval; an ask is not an allow. */
  authorize(identity: ChangeIdentity, access: RepositoryFileAccess): Promise<{ assertCurrent(): void }>
  /** Records actual repository consumption in the current host source context. */
  recordRead(identity: ChangeIdentity, source: { changeId: string; repo: string; snapshot?: string; path: string; digest?: string }): void
}
export type RepositoryFileErrorCode = 'invalid_request' | 'unsafe_path' | 'not_found' | 'not_file'
  | 'not_directory' | 'too_large' | 'not_text' | 'version_conflict' | 'content_changed' | 'io_unavailable'
export class RepositoryFileError extends Error {
  constructor(readonly code: RepositoryFileErrorCode) {
    super(`仓库文件操作未完成：${code}`)
    this.name = 'RepositoryFileError'
  }
}
export interface RepositoryFileWrite {
  changeId: string
  path: string
  expectedSnapshot: string
  /** null means create a new file. Removing a file requires its actual digest. */
  expectedDigest: string | null
  content: string | null
}
export interface RepositoryFileReadOptions {
  /** files validates the actual bytes read; snapshot additionally hashes the whole tree. */
  consistency?: 'files' | 'snapshot'
  /** Supplying a tree expectation always selects strict snapshot consistency. */
  expectedSnapshot?: string
}
export interface RepositoryFileRead extends RepositoryFileReadOptions { changeId: string; path: string }
interface RepositoryFileContent { path: string; digest: string; bytes: number; content: string }
interface RepositoryFileReadResult extends RepositoryFileContent { changeId: string; repo: string; snapshot?: string; consistency?: 'files' }
interface RepositoryFileBatchRead extends RepositoryFileReadOptions { changeId: string; paths: string[] }
interface RepositoryFileBatchResult { changeId: string; repo: string; snapshot?: string; consistency?: 'files'; files: RepositoryFileContent[] }
export interface RepositoryFileSearch extends RepositoryFileReadOptions {
  changeId: string
  path?: string
  /** Case-sensitive literal text, never a regular expression or shell command. */
  query: string
  mode?: 'content' | 'path'
  limit?: number
  /** Continuation position, never an authority or cumulative coverage proof. Path mode only. */
  cursor?: string
}
export interface RepositoryFileSearchBatch extends Omit<RepositoryFileSearch, 'query'> { queries: string[] }
export interface RepositoryFileSearchMatch { path: string; kind?: 'directory'; line?: number; text?: string; /** Present when the actual file bytes were read (content mode). */ digest?: string }

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 20_000
const MAX_PATH_ENTRIES = 20_000
const MAX_PATH_INVENTORY_ENTRIES = 50_000
const MAX_PATH_INVENTORY_BYTES = 16 * 1024 * 1024
const MAX_CURSOR_BYTES = 64 * 1024
const MAX_SEARCH_FILES = 2_000
const MAX_SEARCH_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_SNIPPET = 240
const MAX_READ_FILES = 16
const MAX_READ_BYTES = 4 * MAX_TEXT_BYTES
const MAX_SEARCH_QUERIES = 8
const MARKER = '.friday-change.json'
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const fail = (code: RepositoryFileErrorCode): never => { throw new RepositoryFileError(code) }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

function relativePath(value: string, rootAllowed = false): string[] {
  if (rootAllowed && (value === '' || value === '.')) return []
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\\\x00-\x1f\x7f]/.test(value)) fail('unsafe_path')
  const segments = value.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part === MARKER)) fail('unsafe_path')
  return segments
}

function strictRead(input: RepositoryFileReadOptions): boolean {
  if ((input.consistency !== undefined && !['files', 'snapshot'].includes(input.consistency))
    || (input.expectedSnapshot !== undefined && !/^[a-f0-9]{40,64}$/.test(input.expectedSnapshot))) fail('invalid_request')
  return input.expectedSnapshot !== undefined || input.consistency !== 'files'
}
function readProof(snapshot: string | undefined) {
  return snapshot === undefined ? { consistency: 'files' as const } : { snapshot }
}

type DirectoryEntry = { name: string; kind: 'file' | 'directory' | 'symlink' | 'unsupported' }
type DirectoryView = { entries: DirectoryEntry[]; version: string }
interface PathCursor { version: 1; binding: string; inventory: string; snapshot?: string; offset: number; queryIndex: number }
const directoryKind = (item: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): DirectoryEntry['kind'] =>
  item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'unsupported'
const cursorName = (name: unknown): name is string => typeof name === 'string' && !!name && Buffer.byteLength(name) <= 4096 && !/[\/\0]/.test(name)

/** A version of this directory's identity, names and kinds, not a Git tree or
 * content digest. No stat/cache shortcut participates in write/publish CAS. */
async function directoryView(change: RepositoryChangeLease, segments: string[], check: () => void): Promise<DirectoryView> {
  check()
  const directory = locate(change.dir, [...segments, '']), before = lstatSync(directory)
  if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory) fail('not_directory')
  const entries: DirectoryEntry[] = [], handle = opendirSync(directory)
  let seen = 0
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++seen > MAX_DIRECTORY_ENTRIES) fail('too_large')
      if (seen % 32 === 0) { await new Promise<void>(done => setImmediate(done)); check() }
      if (entry.name.toLowerCase() !== '.git' && entry.name !== MARKER) entries.push({ name: entry.name, kind: directoryKind(entry) })
    }
  } finally { handle.closeSync() }
  check()
  const after = lstatSync(locate(change.dir, [...segments, '']))
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('version_conflict')
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return { entries, version: hash(Buffer.from(JSON.stringify([change.id, segments, before.dev, before.ino, entries]))) }
}

function decodePathCursor(value: string, binding: string, queries: number): PathCursor {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid_request')
  let parsed: PathCursor
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as PathCursor } catch { return fail('invalid_request') }
  if (!parsed || parsed.version !== 1 || parsed.binding !== binding || typeof parsed.inventory !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.inventory)
    || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !Number.isSafeInteger(parsed.queryIndex) || parsed.queryIndex < 0 || parsed.queryIndex >= queries
    || (parsed.snapshot !== undefined && (typeof parsed.snapshot !== 'string' || !/^[a-f0-9]{40,64}$/.test(parsed.snapshot)))) fail('invalid_request')
  return parsed
}

function encodePathCursor(cursor: PathCursor): string {
  const value = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  if (Buffer.byteLength(value) > MAX_CURSOR_BYTES) fail('too_large')
  return value
}

/** No asynchronous gap between walking parents and opening/renaming a file.
 * This is a bounded file broker, not an OS sandbox for repository programs. */
function locate(root: string, segments: readonly string[], createParents = false): string {
  if (resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('unsafe_path')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let info
    try { info = lstatSync(current) } catch (error) {
      if (!missing(error) || !createParents) throw error
      mkdirSync(current, { mode: 0o755 }); info = lstatSync(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current) fail('unsafe_path')
  }
  return segments.length ? join(current, segments.at(-1)!) : root
}

function readRegular(path: string): { data: Buffer; digest: string; mode: number } {
  let info
  try { info = lstatSync(path) } catch (error) { if (missing(error)) fail('not_found'); throw error }
  if (info.isSymbolicLink() || info.nlink !== 1) fail('unsafe_path')
  if (!info.isFile()) fail('not_file')
  if (info.size > MAX_TEXT_BYTES) fail('too_large')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) fail('content_changed')
    if (opened.size > MAX_TEXT_BYTES) fail('too_large')
    if (opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs) fail('content_changed')
    // Reserve just one extra byte to detect growth, rather than zero-filling a
    // megabyte for every small source file in a repository search.
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const data = buffer.subarray(0, length)
    const after = fstatSync(fd), named = lstatSync(path)
    if (data.length > MAX_TEXT_BYTES) fail('too_large')
    if (data.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink() || named.nlink !== 1) fail('content_changed')
    return { data, digest: hash(data), mode: opened.mode & 0o777 }
  } finally { closeSync(fd) }
}

function utf8(data: Buffer): string {
  if (data.includes(0) || attachmentMediaType(data) !== 'application/octet-stream') fail('not_text')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
  catch { return fail('not_text') }
}

/** Real file operations on an already admitted change, with no shell or native
 * model filesystem access. The surrounding ChangeManager lock also owns publish. */
export class RepositoryFiles {
  constructor(private readonly deps: RepositoryFilesDeps) {}

  async list(identity: RepositoryFileIdentity, input: RepositoryFileReadOptions & {
    changeId: string; path?: string; after?: string; limit?: number; expectedDirectoryVersion?: string
  }) {
    const segments = relativePath(input.path ?? '', true), path = segments.join('/')
    const limit = input.limit ?? 100, strict = strictRead({ ...input, consistency: input.consistency ?? 'files' })
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || (input.expectedDirectoryVersion !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedDirectoryVersion))
      || (input.after !== undefined && (!cursorName(input.after) || (!input.expectedSnapshot && !input.expectedDirectoryVersion)))) fail('invalid_request')
    return this.use(identity, input.changeId, { action: 'read', path }, async (change, check) => {
      const snapshot = strict ? await change.snapshot() : undefined; check()
      if (input.expectedSnapshot !== undefined && input.expectedSnapshot !== snapshot) fail('version_conflict')
      const view = await directoryView(change, segments, check); check()
      if (input.expectedDirectoryVersion !== undefined && input.expectedDirectoryVersion !== view.version) fail('version_conflict')
      const visible = view.entries.filter(entry => input.after === undefined || entry.name > input.after)
      const selected = visible.slice(0, limit)
      const entries = selected.map(entry => {
        const item = lstatSync(locate(change.dir, [...segments, entry.name]))
        if (directoryKind(item) !== entry.kind) fail('version_conflict')
        return { ...entry, path: [...segments, entry.name].join('/'), ...(item.isFile() ? { bytes: item.size } : {}) }
      })
      check()
      if (strict) { const after = await change.snapshot(); check(); if (after !== snapshot) fail('version_conflict') }
      this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, ...readProof(snapshot), path }); check()
      return { changeId: change.id, repo: change.repo, ...readProof(snapshot), directoryVersion: view.version, path, entries,
        complete: visible.length <= limit, next: visible.length > limit ? selected.at(-1)!.name : null }
    })
  }

  async read(identity: RepositoryFileIdentity, input: RepositoryFileRead & { consistency?: 'snapshot' }): Promise<RepositoryFileReadResult & { snapshot: string }>
  async read(identity: RepositoryFileIdentity, input: RepositoryFileRead): Promise<RepositoryFileReadResult>
  async read(identity: RepositoryFileIdentity, input: RepositoryFileRead): Promise<RepositoryFileReadResult> {
    const segments = relativePath(input.path), strict = strictRead(input)
    return this.use(identity, input.changeId, { action: 'read', path: input.path }, async (change, check) => {
      const snapshot = strict ? await change.snapshot() : undefined; check()
      if (input.expectedSnapshot !== undefined && input.expectedSnapshot !== snapshot) fail('version_conflict')
      const file = readRegular(locate(change.dir, segments)), content = utf8(file.data)
      check()
      this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, ...readProof(snapshot), path: input.path, digest: file.digest }); check()
      return { changeId: change.id, repo: change.repo, ...readProof(snapshot), path: input.path, digest: file.digest, bytes: file.data.length, content }
    })
  }

  /** One read operation and source lease for a bounded set of actual files. A
   * missing or unsafe member fails the whole request; no partial result escapes. */
  async readMany(identity: RepositoryFileIdentity, input: RepositoryFileBatchRead & { consistency?: 'snapshot' }): Promise<RepositoryFileBatchResult & { snapshot: string }>
  async readMany(identity: RepositoryFileIdentity, input: RepositoryFileBatchRead): Promise<RepositoryFileBatchResult>
  async readMany(identity: RepositoryFileIdentity, input: RepositoryFileBatchRead): Promise<RepositoryFileBatchResult> {
    const strict = strictRead(input)
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > MAX_READ_FILES
      || new Set(input.paths).size !== input.paths.length
      || (input.expectedSnapshot !== undefined && !/^[a-f0-9]{40,64}$/.test(input.expectedSnapshot))) fail('invalid_request')
    const paths = input.paths.map(path => ({ path, segments: relativePath(path) }))
    return this.use(identity, input.changeId, paths.map(({ path }) => ({ action: 'read', path })), async (change, check) => {
      const snapshot = strict ? await change.snapshot() : undefined; check()
      if (input.expectedSnapshot !== undefined && snapshot !== input.expectedSnapshot) fail('version_conflict')
      let bytes = 0
      const files = paths.map(({ path, segments }) => {
        const file = readRegular(locate(change.dir, segments))
        bytes += file.data.length
        if (bytes > MAX_READ_BYTES) fail('too_large')
        return { path, digest: file.digest, bytes: file.data.length, content: utf8(file.data) }
      })
      check()
      if (strict) {
        const after = await change.snapshot(); check()
        if (after !== snapshot) fail('version_conflict')
      }
      for (const file of files) {
        this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, ...readProof(snapshot), path: file.path, digest: file.digest }); check()
      }
      return { changeId: change.id, repo: change.repo, ...readProof(snapshot), files }
    })
  }

  /** A read of one admitted change, not a filesystem search capability. The
   * change lock serializes gateway writes. Snapshot mode additionally compares
   * before/after tree identity; files mode reports only the bytes actually read.
   * Limits describe incomplete coverage; they never turn it into an empty hit. */
  async search(identity: RepositoryFileIdentity, input: RepositoryFileSearch) {
    const result = await this.searchMany(identity, { ...input, queries: [input.query] })
    const { query: _query, ...scan } = result.results[0]!
    const { results: _results, ...base } = result
    return { ...base, ...scan }
  }

  async searchMany(identity: RepositoryFileIdentity, input: RepositoryFileSearchBatch) {
    const segments = relativePath(input.path ?? '', true), path = segments.join('/'), strict = strictRead(input)
    const mode = input.mode ?? 'content', limit = input.limit ?? 50
    if (!Array.isArray(input.queries) || !input.queries.length || input.queries.length > MAX_SEARCH_QUERIES
      || new Set(input.queries).size !== input.queries.length
      || input.queries.some(query => typeof query !== 'string' || !query || query.includes('\0') || Buffer.byteLength(query) > 4096)
      || input.queries.reduce((bytes, query) => bytes + Buffer.byteLength(query), 0) > 4096
      || (input.cursor !== undefined && mode !== 'path')
      || !['content', 'path'].includes(mode) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('invalid_request')
    if (mode === 'path') return this.searchPaths(identity, input, segments, strict, limit)
    return this.use(identity, input.changeId, { action: 'read', path }, async (change, check) => {
      const snapshot = strict ? await change.snapshot() : undefined; check()
      if (input.expectedSnapshot !== undefined && input.expectedSnapshot !== snapshot) fail('version_conflict')
      const results = input.queries.map(query => ({ query, matches: [] as RepositoryFileSearchMatch[] }))
      let matchCount = 0
      const pending: string[][] = []
      let scannedEntries = 0, scannedFiles = 0, scannedBytes = 0, skippedFiles = 0
      let limitReason: 'matches' | 'entries' | 'files' | 'bytes' | undefined
      const visit = (itemSegments: string[]): void => {
        const itemPath = itemSegments.join('/')
        // Every name and file descriptor is checked even within a synchronous
        // chunk. Full authority is renewed at each asynchronous boundary.
        try { relativePath(itemPath) } catch (error) {
          if (!(error instanceof RepositoryFileError && error.code === 'unsafe_path')) throw error
          skippedFiles++; return
        }
        const absolute = locate(change.dir, itemSegments), item = lstatSync(absolute)
        if (item.isSymbolicLink()) { skippedFiles++; return }
        if (item.isDirectory()) { pending.push(itemSegments); return }
        if (!item.isFile() || item.nlink !== 1) { skippedFiles++; return }
        if (scannedFiles === MAX_SEARCH_FILES) { limitReason = 'files'; return }
        scannedFiles++
        if (item.size > MAX_TEXT_BYTES) { skippedFiles++; return }
        if (scannedBytes + item.size > MAX_SEARCH_BYTES) { limitReason = 'bytes'; return }
        let content: string, digest: string
        try {
          const file = readRegular(absolute)
          scannedBytes += file.data.length
          if (scannedBytes > MAX_SEARCH_BYTES) { limitReason = 'bytes'; return }
          content = utf8(file.data); digest = file.digest
        } catch (error) {
          if (!(error instanceof RepositoryFileError && (error.code === 'not_text' || error.code === 'too_large'))) throw error
          skippedFiles++; return
        }
        for (const result of results) {
          let cursor = 0, line = 1, lineStart = 0
          while (cursor <= content.length) {
            const offset = content.indexOf(result.query, cursor)
            if (offset < 0) break
            for (let newline = content.indexOf('\n', lineStart); newline >= 0 && newline < offset; newline = content.indexOf('\n', lineStart)) {
              line++; lineStart = newline + 1
            }
            const newline = content.indexOf('\n', offset), lineEnd = newline < 0 ? content.length : newline
            if (matchCount === limit) { limitReason = 'matches'; return }
            const start = Math.max(lineStart, offset - 80), end = Math.min(lineEnd, start + MAX_SEARCH_SNIPPET)
            result.matches.push({ path: itemPath, digest, line, text: `${start > lineStart ? '…' : ''}${content.slice(start, end)}${end < lineEnd ? '…' : ''}` })
            matchCount++
            cursor = lineEnd + 1
          }
        }
      }
      // A concrete file is a valid narrow search target, not a directory error
      // which sends the model back to scanning the whole repository.
      const target = locate(change.dir, segments), targetInfo = lstatSync(target)
      if (targetInfo.isSymbolicLink()) fail('unsafe_path')
      if (targetInfo.isDirectory()) pending.push(segments)
      else if (targetInfo.isFile()) { scannedEntries++; visit(segments) }
      else fail('not_file')
      scan: while (pending.length) {
        check()
        const currentSegments = pending.pop()!
        const directory = locate(change.dir, [...currentSegments, ''])
        const info = lstatSync(directory)
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) fail('not_directory')
        const handle = opendirSync(directory)
        try {
          for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
            if (scannedEntries === MAX_DIRECTORY_ENTRIES) { limitReason = 'entries'; break scan }
            scannedEntries++
            if (scannedEntries % 32 === 0) { await new Promise<void>(done => setImmediate(done)); check() }
            if (entry.name.toLowerCase() === '.git' || entry.name === MARKER) continue
            visit([...currentSegments, entry.name])
            if (limitReason) break scan
          }
        } finally { handle.closeSync() }
      }
      check()
      if (strict) {
        const after = await change.snapshot(); check()
        if (after !== snapshot) fail('version_conflict')
      }
      this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, ...readProof(snapshot), path }); check()
      return { changeId: change.id, repo: change.repo, ...readProof(snapshot), path, mode,
        nextCursor: undefined as string | null | undefined, coverage: undefined as 'page' | undefined,
        inventory: undefined as { scope: 'tracked_and_nonignored_untracked'; version: string; complete: boolean } | undefined,
        results: results.map(result => ({ ...result, truncated: limitReason !== undefined,
          scannedFiles, scannedEntries, scannedBytes, skippedFiles, ...(limitReason ? { limitReason } : {}) })) }
    })
  }

  private async searchPaths(identity: RepositoryFileIdentity, input: RepositoryFileSearchBatch, segments: string[], strict: boolean, limit: number) {
    const path = segments.join('/'), binding = hash(Buffer.from(JSON.stringify([input.changeId, path, input.queries, strict])))
    const cursor = input.cursor === undefined ? undefined : decodePathCursor(input.cursor, binding, input.queries.length)
    if (cursor && (cursor.snapshot !== undefined) !== strict) fail('invalid_request')
    return this.use(identity, input.changeId, { action: 'read', path }, async (change, check) => {
      const snapshot = strict ? await change.snapshot() : undefined; check()
      if ((input.expectedSnapshot !== undefined && snapshot !== input.expectedSnapshot) || (cursor && snapshot !== cursor.snapshot)) fail('version_conflict')
      const target = lstatSync(locate(change.dir, segments))
      if (target.isSymbolicLink()) fail('unsafe_path')
      if (!target.isDirectory() && !target.isFile()) fail('not_file')
      const collect = async () => {
        const raw = await change.pathInventory(path); check()
        const candidates = new Map<string, 'file' | 'directory'>()
        let complete = raw.complete, skipped = 0, bytes = 0, visited = 0
        outer: for (const name of raw.paths) {
          if (++visited % 128 === 0) { await new Promise<void>(done => setImmediate(done)); check() }
          let parts: string[]
          try { parts = relativePath(name) } catch (error) {
            if (!(error instanceof RepositoryFileError && error.code === 'unsafe_path')) throw error
            skipped++; continue
          }
          if (path && name !== path && !name.startsWith(`${path}/`)) fail('content_changed')
          for (let length = parts.length; length > segments.length || (length === segments.length && name === path); length--) {
            const candidate = parts.slice(0, length).join('/')
            if (candidates.has(candidate)) continue
            const size = Buffer.byteLength(candidate)
            if (candidates.size === MAX_PATH_INVENTORY_ENTRIES || bytes + size > MAX_PATH_INVENTORY_BYTES) { complete = false; break outer }
            candidates.set(candidate, length === parts.length ? 'file' : 'directory'); bytes += size
          }
        }
        const entries = [...candidates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        return { entries, complete, skipped, version: hash(Buffer.from(JSON.stringify([change.id, path, complete, entries]))) }
      }
      const inventory = await collect(); check()
      if (cursor && cursor.inventory !== inventory.version) fail('version_conflict')
      if (cursor && cursor.offset >= inventory.entries.length) fail('invalid_request')
      const results = input.queries.map(query => ({ query, matches: [] as RepositoryFileSearchMatch[] }))
      let scannedEntries = 0, scannedFiles = 0, skippedFiles = inventory.skipped, matchCount = 0
      let limitReason: 'entries' | 'matches' | 'inventory' | undefined, next: { offset: number; queryIndex: number } | undefined
      scan: for (let offset = cursor?.offset ?? 0; offset < inventory.entries.length; offset++) {
        if (scannedEntries === MAX_PATH_ENTRIES) { limitReason = 'entries'; next = { offset, queryIndex: 0 }; break }
        scannedEntries++
        if (scannedEntries % 32 === 0) { await new Promise<void>(done => setImmediate(done)); check() }
        const [name, candidateKind] = inventory.entries[offset]!
        if (candidateKind === 'file') scannedFiles++
        const queryStart = offset === cursor?.offset ? cursor.queryIndex : 0
        if (!results.slice(queryStart).some(result => name.includes(result.query))) continue
        let item
        try { item = lstatSync(locate(change.dir, relativePath(name))) } catch (error) {
          if (missing(error) || error instanceof RepositoryFileError && error.code === 'unsafe_path') { skippedFiles++; continue }
          throw error
        }
        if (item.isSymbolicLink() || (!item.isDirectory() && (!item.isFile() || item.nlink !== 1))) { skippedFiles++; continue }
        for (let queryIndex = queryStart; queryIndex < results.length; queryIndex++) {
          const result = results[queryIndex]!
          if (!name.includes(result.query)) continue
          if (matchCount === limit) { limitReason = 'matches'; next = { offset, queryIndex }; break scan }
          result.matches.push({ path: name, ...(item.isDirectory() ? { kind: 'directory' as const } : {}) }); matchCount++
        }
      }
      // Re-read the trusted candidate names, never reuse a filesystem stat
      // cache. The version describes eligible names, not bytes or an atomic
      // content snapshot. Each returned path was independently checked above.
      const afterInventory = await collect(); check()
      if (afterInventory.version !== inventory.version) fail('version_conflict')
      if (strict) { const after = await change.snapshot(); check(); if (after !== snapshot) fail('version_conflict') }
      if (!next && !inventory.complete) limitReason = 'inventory'
      const nextCursor = next ? encodePathCursor({ version: 1, binding, inventory: inventory.version, ...(snapshot ? { snapshot } : {}), ...next }) : null
      this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, ...readProof(snapshot), path }); check()
      return { changeId: change.id, repo: change.repo, ...readProof(snapshot), path, mode: 'path' as const,
        nextCursor, coverage: 'page' as const, inventory: { scope: 'tracked_and_nonignored_untracked' as const, version: inventory.version, complete: inventory.complete },
        results: results.map(result => ({ ...result, truncated: nextCursor !== null || !inventory.complete, scannedFiles, scannedEntries, scannedBytes: 0,
          skippedFiles, ...(limitReason ? { limitReason } : {}) })) }
    })
  }

  private writeInput(input: RepositoryFileWrite) {
    const segments = relativePath(input.path)
    if (typeof input.expectedSnapshot !== 'string' || !/^[a-f0-9]{40,64}$/.test(input.expectedSnapshot)
      || (input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest))
      || (input.content !== null && typeof input.content !== 'string') || (input.content === null && input.expectedDigest === null)) fail('invalid_request')
    const data = input.content === null ? null : Buffer.from(input.content, 'utf8')
    if (data && (data.length > MAX_TEXT_BYTES || data.includes(0))) fail(data.length > MAX_TEXT_BYTES ? 'too_large' : 'not_text')
    if (data && utf8(data) !== input.content) fail('not_text')
    return { segments, data, desiredDigest: data === null ? null : hash(data) }
  }

  async write(identity: RepositoryFileIdentity, input: RepositoryFileWrite) {
    const prepared = this.writeInput(input)
    return this.use(identity, input.changeId, { action: 'write', path: input.path,
      expectedSnapshot: input.expectedSnapshot, expectedDigest: input.expectedDigest, contentDigest: prepared.desiredDigest },
    (change, check) => this.writeCurrent(identity, input, prepared, change, check))
  }

  private async writeCurrent(identity: RepositoryFileIdentity, input: RepositoryFileWrite,
    prepared: ReturnType<RepositoryFiles['writeInput']>, change: RepositoryChangeLease, check: () => void) {
    const { segments, data, desiredDigest } = prepared
    const before = await change.snapshot(); check()
    if (before !== input.expectedSnapshot) fail('version_conflict')
    const path = locate(change.dir, segments, data !== null)
    let existing: ReturnType<typeof readRegular> | undefined
    try { existing = readRegular(path) } catch (error) {
      if (!(error instanceof RepositoryFileError && error.code === 'not_found')) throw error
    }
    if ((existing?.digest ?? null) !== input.expectedDigest) fail('version_conflict')
    if (existing) utf8(existing.data)
    check()
    if (data === null) unlinkSync(path)
    else {
      // A crash can leave this temporary file only inside Git metadata, which
      // cannot enter a published tree or be read through this broker.
      const metadata = join(change.dir, '.git')
      if (!lstatSync(metadata).isDirectory() || realpathSync(metadata) !== metadata) fail('unsafe_path')
      const temporary = join(metadata, `friday-file-${randomUUID()}`)
      let fd: number | undefined
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, existing?.mode ?? 0o644)
        writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
        check()
        renameSync(temporary, path)
      } finally {
        if (fd !== undefined) closeSync(fd)
        try { unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error }
      }
    }
    const directory = openSync(dirname(path), constants.O_RDONLY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
    // If cancellation or shutdown occurs after the mutation, propagate it.
    // The API's existing before-call ledger must preserve an uncertain result;
    // a failed response is never evidence that these bytes were not changed.
    const snapshot = await change.snapshot(); check()
    this.deps.recordRead(identity, { changeId: change.id, repo: change.repo, snapshot, path: input.path,
      ...(desiredDigest ? { digest: desiredDigest } : {}) }); check()
    return { changeId: change.id, repo: change.repo, path: input.path, previousSnapshot: before, snapshot,
      previousDigest: existing?.digest ?? null, digest: desiredDigest, bytes: data?.length ?? 0,
      action: data === null ? 'deleted' as const : existing ? 'updated' as const : 'created' as const,
      validation: { localExecution: 'not_run' as const, ci: 'not_checked' as const } }
  }

  /** Read, approve exact resulting bytes, and compare-and-swap under the one
   * publisher lock. Approval may await; the complete tree and file are checked
   * again afterwards, before the first write. No extra discovery snapshot. */
  async edit(identity: RepositoryFileIdentity, input: {
    changeId: string; path: string; expectedSnapshot: string; expectedDigest: string; oldText: string; newText: string
  }) {
    if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string' ||
      typeof input.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedDigest)
      || typeof input.expectedSnapshot !== 'string' || !/^[a-f0-9]{40,64}$/.test(input.expectedSnapshot)) fail('invalid_request')
    const segments = relativePath(input.path)
    return this.use(identity, input.changeId, { action: 'read', path: input.path }, async (change, readCurrent) => {
      const file = readRegular(locate(change.dir, segments)), content = utf8(file.data)
      readCurrent()
      if (file.digest !== input.expectedDigest) fail('version_conflict')
      const offset = content.indexOf(input.oldText)
      if (offset < 0 || content.indexOf(input.oldText, offset + 1) >= 0) fail('invalid_request')
      const write = { changeId: input.changeId, path: input.path, expectedSnapshot: input.expectedSnapshot,
        expectedDigest: input.expectedDigest,
        content: content.slice(0, offset) + input.newText + content.slice(offset + input.oldText.length) }
      const prepared = this.writeInput(write)
      const authorized = await this.deps.authorize(identity, { action: 'write', changeId: change.id, repo: change.repo,
        path: input.path, expectedSnapshot: input.expectedSnapshot, expectedDigest: input.expectedDigest,
        contentDigest: prepared.desiredDigest })
      const check = () => { readCurrent(); authorized.assertCurrent() }
      check()
      return this.writeCurrent(identity, write, prepared, change, check)
    })
  }

  private use<T>(identity: RepositoryFileIdentity, id: string, access: Omit<RepositoryFileAccess, 'changeId' | 'repo'> | Omit<RepositoryFileAccess, 'changeId' | 'repo'>[],
    use: (change: RepositoryChangeLease, check: () => void) => Promise<T>): Promise<T> {
    if (typeof id !== 'string' || !id.trim() || !identity.sessionKey || !identity.requesterOpenId) fail('invalid_request')
    return this.deps.changes.withChange({ ...identity, id }, async change => {
      const current = () => { identity.signal?.throwIfAborted(); identity.assertAuthorized?.(); change.assertCurrent() }
      current()
      if (change.id !== id) fail('content_changed')
      const authorizations: { assertCurrent(): void }[] = []
      const check = () => { current(); for (const authorization of authorizations) authorization.assertCurrent() }
      for (const item of Array.isArray(access) ? access : [access]) {
        check()
        const authorization = await this.deps.authorize(identity, { ...item, changeId: change.id, repo: change.repo }); check()
        authorizations.push(authorization); check()
      }
      check()
      return use(change, check)
    }).catch(error => {
      // Filesystem diagnostics contain host paths. Expose a typed cause rather
      // than returning Node's raw error text through a model tool.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new RepositoryFileError('not_found')
      if (code === 'ELOOP') throw new RepositoryFileError('unsafe_path')
      if (code === 'ENOTDIR') throw new RepositoryFileError('not_directory')
      if (['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'EXDEV'].includes(code ?? '')) throw new RepositoryFileError('io_unavailable')
      throw error
    })
  }
}

/** The broker's own path, lookup and CAS primitives, reused by execution-output
 * import so both writers apply identical rules to a change's files. */
export { relativePath as repositoryRelativePath, locate as locateRepositoryPath, readRegular as readRepositoryFile, utf8 as repositoryText }
