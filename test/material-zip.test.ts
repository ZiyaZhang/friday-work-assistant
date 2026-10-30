import { describe, expect, it } from 'vitest'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { createManagedZip, extractManagedZip, inspectManagedZip, MATERIAL_ZIP_LIMITS } from '../src/core/execution-material-zip.js'

const current = () => {}
async function archive(entries: { name: string; data?: Buffer; directory?: boolean; mode?: number }[], password?: string) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 })
  for (const entry of entries) await writer.add(entry.name, entry.directory ? undefined : new Uint8ArrayReader(entry.data ?? Buffer.from('evidence')),
    { directory: entry.directory, ...(entry.mode ? { unixMode: entry.mode } : {}), ...(password ? { password } : {}) })
  return Buffer.from(await writer.close())
}

describe('managed ZIP bytes (real library, no filesystem extraction)', () => {
  it('preserves Chinese nested names and bytes, normalizes separators, and does not confuse repeated directory names', async () => {
    const bytes = await archive([{ name: '材料/' , directory: true }, { name: '材料/材料/', directory: true },
      { name: '材料/材料/说明.txt', data: Buffer.from('事实\n不是执行指令') }, { name: 'logs\\trace.json', data: Buffer.from('{"ok":true}') }])
    expect((await inspectManagedZip(bytes, current)).map(entry => entry.name)).toEqual(['材料/', '材料/材料/', '材料/材料/说明.txt', 'logs/trace.json'])
    const selected = await extractManagedZip(bytes, ['logs/trace.json', '材料/材料/说明.txt'], current)
    expect(selected.map(item => [item.member, item.name, item.data.toString()])).toEqual([
      ['logs/trace.json', 'trace.json', '{"ok":true}'], ['材料/材料/说明.txt', '说明.txt', '事实\n不是执行指令']])
  })

  it.each(['../outside.txt', '/absolute.txt', 'C:\\outside.txt', 'a/../../outside.txt', 'a/\0evil'])('rejects unsafe member %j before returning a directory', async name => {
    const data = await archive([{ name }])
    await expect(inspectManagedZip(data, current)).rejects.toMatchObject({ code: 'unsafe_archive' })
  })

  it('rejects canonical duplicates, file/directory conflicts and symlinks', async () => {
    for (const entries of [
      [{ name: 'a/b.txt' }, { name: 'a\\b.txt' }],
      [{ name: 'a' }, { name: 'a/b.txt' }],
      [{ name: 'linked.txt', mode: 0o120777 }],
    ]) await expect(inspectManagedZip(await archive(entries), current)).rejects.toMatchObject({ code: 'unsafe_archive' })
  })

  it('rejects encrypted archives and missing/directory/duplicate selections explicitly', async () => {
    await expect(inspectManagedZip(await archive([{ name: 'private.txt' }], 'test-only'), current)).rejects.toMatchObject({ code: 'encrypted_archive' })
    const data = await archive([{ name: 'a/', directory: true }, { name: 'a/file.txt' }])
    for (const selected of [['missing.txt'], ['a/'], ['a/file.txt', 'a/file.txt']]) {
      await expect(extractManagedZip(data, selected, current)).rejects.toMatchObject({ code: 'archive_member_missing' })
    }
  })

  it('bounds directory count and inflated size, including archives lying about their output size', async () => {
    const small = await archive([{ name: 'a.txt' }, { name: 'b.txt' }])
    await expect(inspectManagedZip(small, current, { ...MATERIAL_ZIP_LIMITS, entries: 1 })).rejects.toMatchObject({ code: 'archive_limit' })
    const zip = await createManagedZip([{ name: 'large.txt', data: Buffer.alloc(16 * 1024, 65) }], current)
    await expect(extractManagedZip(zip, ['large.txt'], current, { ...MATERIAL_ZIP_LIMITS, bytes: 2048 })).rejects.toMatchObject({ code: 'archive_limit' })
    // Both headers claim one byte, while the actual deflate stream still expands to 16 KiB.
    const local = zip.indexOf(Buffer.from('504b0304', 'hex')), central = zip.indexOf(Buffer.from('504b0102', 'hex'))
    zip.writeUInt32LE(1, local + 22); zip.writeUInt32LE(1, central + 24)
    // zip.js rejects the over-inflation before writing it to our bounded sink.
    await expect(extractManagedZip(zip, ['large.txt'], current, { ...MATERIAL_ZIP_LIMITS, bytes: 2048 })).rejects.toMatchObject({ code: 'invalid_archive' })
  })

  it('rejects corruption and local/central filename disagreements', async () => {
    const bytes = await archive([{ name: 'safe.txt', data: Buffer.from('a unique payload') }])
    const corrupt = Buffer.from(bytes); corrupt[corrupt.indexOf('a unique payload')]! ^= 1
    await expect(extractManagedZip(corrupt, ['safe.txt'], current)).rejects.toMatchObject({ code: 'invalid_archive' })
    const ambiguous = Buffer.from(bytes); ambiguous[ambiguous.indexOf('safe.txt')] = 'x'.charCodeAt(0)
    await expect(extractManagedZip(ambiguous, ['safe.txt'], current)).rejects.toMatchObject({ code: 'invalid_archive' })
  })

  it('produces deterministic archives for stable write retries and checks the host lease inside stream writes', async () => {
    const files = [{ name: 'report.txt', data: Buffer.from('Known facts only') }, { name: 'prototype/index.html', data: Buffer.from('<button>Open</button>') }]
    const one = await createManagedZip(files, current), two = await createManagedZip(files, current)
    expect(two).toEqual(one)
    expect((await extractManagedZip(one, files.map(file => file.name), current)).map(item => item.data)).toEqual(files.map(file => file.data))
    const reason = new Error('stopped-host-lease')
    let checks = 0
    await expect(extractManagedZip(one, ['report.txt'], () => { if (++checks === 5) throw reason })).rejects.toBe(reason)
    await expect(createManagedZip([{ name: 'a', data: Buffer.from('1') }, { name: 'a/b', data: Buffer.from('2') }], current)).rejects.toMatchObject({ code: 'unsafe_archive' })
  })
})
