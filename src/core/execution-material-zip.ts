import { WritableStream } from 'node:stream/web'
import { ERR_UNSAFE_FILENAME, Uint8ArrayReader, ZipReader, ZipWriter, type Entry } from '@zip.js/zip.js'

/** ZIP bytes never become filesystem paths. These budgets bound one host operation,
 * including actual inflated bytes rather than trusting the archive's size claims. */
export const MATERIAL_ZIP_LIMITS = Object.freeze({ entries: 2048, bytes: 64 * 1024 * 1024, nameBytes: 1024, timeoutMs: 20_000 })
export type MaterialZipLimits = typeof MATERIAL_ZIP_LIMITS
export type MaterialZipCode = 'invalid_archive' | 'unsafe_archive' | 'encrypted_archive' | 'archive_limit' | 'archive_member_missing'
export class MaterialZipError extends Error {
  constructor(readonly code: MaterialZipCode) {
    super(({ invalid_archive: 'ZIP 无法完整核验，未解包任何文件。', unsafe_archive: 'ZIP 含不安全或冲突的成员路径、链接或特殊文件，未解包。',
      encrypted_archive: '暂不支持加密 ZIP，请提供未加密且允许读取的文件。', archive_limit: 'ZIP 超出本次文件数量、大小或处理时间上限，未登记半成品。',
      archive_member_missing: '未找到选定的普通文件，请使用目录返回的完整成员名称。' })[code])
    this.name = 'MaterialZipError'
  }
}
export interface MaterialZipEntry { name: string; directory: boolean; size: number; compressedSize: number }
interface ParsedEntry { entry: Entry; info: MaterialZipEntry }

function pathName(name: string, directory: boolean, limits: MaterialZipLimits): string {
  if (!name || Buffer.byteLength(name) > limits.nameBytes || /^[\\/]/.test(name) || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw new MaterialZipError('unsafe_archive')
  }
  const parts = name.replace(/\\/g, '/').split('/')
  if (parts.includes('..')) throw new MaterialZipError('unsafe_archive')
  const normalized = parts.filter(part => part && part !== '.').join('/')
  if (!normalized || normalized.split('/').at(-1)!.length > 255) throw new MaterialZipError('unsafe_archive')
  return normalized + (directory ? '/' : '')
}

async function withArchive<T>(data: Buffer, assertCurrent: () => void, work: (entries: ParsedEntry[], signal: AbortSignal, check: () => void) => Promise<T>,
  limits: MaterialZipLimits): Promise<T> {
  assertCurrent()
  if (data.length > limits.bytes) throw new MaterialZipError('archive_limit')
  const signal = AbortSignal.timeout(limits.timeoutMs)
  let hostFailure: { error: unknown } | undefined
  const check = () => {
    try { assertCurrent() } catch (error) { hostFailure = { error }; throw error }
    if (signal.aborted) throw new MaterialZipError('archive_limit')
  }
  const reader = new ZipReader(new Uint8ArrayReader(data), { useWebWorkers: false, strictness: 'strict', checkCrc32: true,
    checkOverlappingEntry: true, signal })
  try {
    const entries = new Map<string, ParsedEntry>()
    let count = 0
    for await (const entry of reader.getEntriesGenerator()) {
      check()
      if (++count > limits.entries) throw new MaterialZipError('archive_limit')
      if (entry.encrypted) throw new MaterialZipError('encrypted_archive')
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      if (entry.symlink || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
        (mode === 0x4000 && !entry.directory) || (mode === 0x8000 && entry.directory)) throw new MaterialZipError('unsafe_archive')
      const name = pathName(entry.filename, entry.directory, limits), key = name.replace(/\/$/, '')
      if (![entry.uncompressedSize, entry.compressedSize].every(value => Number.isSafeInteger(value) && value >= 0)) throw new MaterialZipError('invalid_archive')
      const previous = entries.get(key)
      // Repeated directory records carry no file content; ordinary nested names are legal.
      if (previous && (!entry.directory || !previous.info.directory)) throw new MaterialZipError('unsafe_archive')
      if (!previous) entries.set(key, { entry, info: { name, directory: entry.directory, size: entry.uncompressedSize, compressedSize: entry.compressedSize } })
    }
    check()
    for (const key of entries.keys()) {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = entries.get(parts.slice(0, i).join('/'))
        if (parent && !parent.info.directory) throw new MaterialZipError('unsafe_archive')
      }
    }
    const result = await work([...entries.values()], signal, check)
    check()
    return result
  } catch (error) {
    if (hostFailure) throw hostFailure.error
    check() // A revoked source/request must keep its host failure, not become a corrupt ZIP.
    if (error instanceof MaterialZipError) throw error
    if (error instanceof Error && error.message === ERR_UNSAFE_FILENAME) throw new MaterialZipError('unsafe_archive')
    throw new MaterialZipError('invalid_archive')
  } finally { await reader.close() }
}

export function inspectManagedZip(data: Buffer, assertCurrent: () => void, limits: MaterialZipLimits = MATERIAL_ZIP_LIMITS): Promise<MaterialZipEntry[]> {
  return withArchive(data, assertCurrent, async entries => entries.map(item => item.info), limits)
}

/** Complete all selected reads before the application registers any output. */
export function extractManagedZip(data: Buffer, members: readonly string[], assertCurrent: () => void,
  limits: MaterialZipLimits = MATERIAL_ZIP_LIMITS): Promise<{ member: string; name: string; data: Buffer }[]> {
  return withArchive(data, assertCurrent, async (entries, signal, check) => {
    if (!members.length || members.length > 100 || new Set(members).size !== members.length) throw new MaterialZipError('archive_member_missing')
    const selected = members.map(name => entries.find(item => item.info.name === name && !item.info.directory))
    if (selected.some(item => !item)) throw new MaterialZipError('archive_member_missing')
    if (selected.reduce((sum, item) => sum + item!.info.size, 0) > limits.bytes) throw new MaterialZipError('archive_limit')
    let total = 0
    const result: { member: string; name: string; data: Buffer }[] = []
    for (const item of selected) {
      check()
      const { entry, info } = item!
      if (entry.directory) throw new MaterialZipError('archive_member_missing')
      const chunks: Buffer[] = []
      await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
        check()
        total += chunk.byteLength
        if (total > limits.bytes) throw new MaterialZipError('archive_limit')
        chunks.push(Buffer.from(chunk))
      } }), { signal, checkCrc32: true, checkOverlappingEntry: true, strictness: 'strict', useWebWorkers: false })
      check()
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== info.size) throw new MaterialZipError('invalid_archive')
      result.push({ member: info.name, name: info.name.split('/').at(-1)!, data: bytes })
    }
    return result
  }, limits)
}

export async function createManagedZip(files: readonly { name: string; data: Buffer }[], assertCurrent: () => void,
  limits: MaterialZipLimits = MATERIAL_ZIP_LIMITS): Promise<Buffer> {
  assertCurrent()
  if (!files.length || files.length > 100 || files.length > limits.entries || files.reduce((sum, file) => sum + file.data.length, 0) > limits.bytes) {
    throw new MaterialZipError('archive_limit')
  }
  const normalized = files.map(file => ({ ...file, name: pathName(file.name, false, limits) }))
  const names = new Set(normalized.map(file => file.name))
  if (names.size !== normalized.length || normalized.some(file => {
    const parts = file.name.split('/')
    return parts.some((_part, i) => i > 0 && names.has(parts.slice(0, i).join('/')))
  })) throw new MaterialZipError('unsafe_archive')
  const chunks: Buffer[] = [], signal = AbortSignal.timeout(limits.timeoutMs)
  let size = 0
  let hostFailure: { error: unknown } | undefined
  const check = () => {
    try { assertCurrent() } catch (error) { hostFailure = { error }; throw error }
    if (signal.aborted) throw new MaterialZipError('archive_limit')
  }
  const writer = new ZipWriter(new WritableStream<Uint8Array>({ write(chunk) {
    check(); size += chunk.byteLength
    if (size > limits.bytes) throw new MaterialZipError('archive_limit')
    chunks.push(Buffer.from(chunk))
  } }), { useWebWorkers: false, useCompressionStream: false, level: 6, signal, keepOrder: true,
    lastModDate: new Date('1980-01-01T00:00:00Z'), extendedTimestamp: false })
  try {
    for (const file of normalized) {
      check()
      await writer.add(file.name, new Uint8ArrayReader(file.data))
      check()
    }
    await writer.close()
    check()
    return Buffer.concat(chunks)
  } catch (error) {
    if (hostFailure) throw hostFailure.error
    check()
    if (error instanceof MaterialZipError) throw error
    throw new MaterialZipError('invalid_archive')
  }
}
