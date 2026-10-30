import { describe, expect, it } from 'vitest'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { createManagedZip, extractManagedZip, inspectManagedZip, MATERIAL_ZIP_LIMITS, type MaterialZipLimits } from '../src/core/execution-material-zip.js'

const current = () => {}
/** MATERIAL_ZIP_LIMITS is frozen with literal types; a test budget is the same shape with smaller numbers. */
const budget = (override: Partial<Record<keyof MaterialZipLimits, number>>) => ({ ...MATERIAL_ZIP_LIMITS, ...override }) as MaterialZipLimits
async function archive(entries: { name: string; data?: Buffer }[], level = 0) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level })
  for (const entry of entries) await writer.add(entry.name, new Uint8ArrayReader(entry.data ?? Buffer.from('evidence')))
  return Buffer.from(await writer.close())
}
/** Reduce a result to its error code or a short summary, so a wrong outcome is never printed as megabytes of buffer. */
const outcome = (work: Promise<unknown>) => work.then(value => Array.isArray(value) ? `resolved:${value.length}` : 'resolved',
  (error: { code?: string }) => error.code ?? 'unexpected_error')
function endRecord(zip: Buffer) {
  const at = zip.lastIndexOf(Buffer.from('504b0506', 'hex'))
  return { at, entries: zip.readUInt16LE(at + 10), size: zip.readUInt32LE(at + 12), offset: zip.readUInt32LE(at + 16) }
}

/** The default budgets in execution-material-zip.ts that material-zip.test.ts exercises only with smaller overrides or not at all. */
describe('managed ZIP budgets and hostile layouts (real library, bytes only)', () => {
  it('lists at most 2048 members by default', async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }))
    expect(await inspectManagedZip(await archive(names(2048)), current)).toHaveLength(2048)
    await expect(inspectManagedZip(await archive(names(2049)), current)).rejects.toMatchObject({ code: 'archive_limit' })
  }, 30_000)

  it('bounds archive bytes before parsing, and packing input count and bytes', async () => {
    const small = await archive([{ name: 'a.txt' }])
    await expect(inspectManagedZip(small, current, budget({ bytes: small.length - 1 }))).rejects.toMatchObject({ code: 'archive_limit' })
    await expect(createManagedZip(Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })), current)).rejects.toMatchObject({ code: 'archive_limit' })
    await expect(createManagedZip([{ name: 'a.txt', data: Buffer.alloc(2049) }], current, budget({ bytes: 2048 }))).rejects.toMatchObject({ code: 'archive_limit' })
  })

  it('rejects member names over 1024 bytes or with a final segment over 255 characters', async () => {
    const deep = 'd/'.repeat(512) + 'f'
    expect(Buffer.byteLength(deep)).toBe(1025)
    await expect(inspectManagedZip(await archive([{ name: deep }]), current)).rejects.toMatchObject({ code: 'unsafe_archive' })
    await expect(inspectManagedZip(await archive([{ name: `dir/${'n'.repeat(256)}` }]), current)).rejects.toMatchObject({ code: 'unsafe_archive' })
    expect((await inspectManagedZip(await archive([{ name: `dir/${'n'.repeat(255)}` }]), current))[0]!.name).toBe(`dir/${'n'.repeat(255)}`)
  })

  it('refuses a high-ratio member at the default 64MiB budget, whether its size is declared or hidden', async () => {
    const bomb = await archive([{ name: 'zeros.bin', data: Buffer.alloc(MATERIAL_ZIP_LIMITS.bytes + 1024) }], 9)
    expect(bomb.length).toBeLessThan(256 * 1024)
    expect(await outcome(extractManagedZip(bomb, ['zeros.bin'], current))).toBe('archive_limit')
    // Both headers claim one byte; the deflate stream still expands past the budget.
    const hidden = Buffer.from(bomb), local = hidden.indexOf(Buffer.from('504b0304', 'hex')), central = hidden.indexOf(Buffer.from('504b0102', 'hex'))
    hidden.writeUInt32LE(1, local + 22); hidden.writeUInt32LE(1, central + 24)
    expect(await outcome(extractManagedZip(hidden, ['zeros.bin'], current))).toBe('invalid_archive')
  }, 30_000)

  it('refuses to extract two members whose stored bytes overlap in one request', async () => {
    // a.txt stores the local record of b.txt as its content; a second central record points b.txt into a.txt's bytes.
    const inner = await archive([{ name: 'b.txt', data: Buffer.from('inner payload') }]), innerEnd = endRecord(inner)
    const outer = await archive([{ name: 'a.txt', data: inner.subarray(0, innerEnd.offset) }]), outerEnd = endRecord(outer)
    const centralB = Buffer.from(inner.subarray(innerEnd.offset, innerEnd.offset + innerEnd.size))
    centralB.writeUInt32LE(30 + outer.readUInt16LE(26) + outer.readUInt16LE(28), 42)
    const end = Buffer.from(outer.subarray(outerEnd.at))
    end.writeUInt16LE(outerEnd.entries + 1, 8); end.writeUInt16LE(outerEnd.entries + 1, 10); end.writeUInt32LE(outerEnd.size + centralB.length, 12)
    const overlapping = Buffer.concat([outer.subarray(0, outerEnd.offset + outerEnd.size), centralB, end])
    expect((await inspectManagedZip(overlapping, current)).map(entry => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(await outcome(extractManagedZip(overlapping, ['a.txt', 'b.txt'], current))).toBe('invalid_archive')
  })

  it('stops inflating a compressed member that runs past its time budget', async () => {
    // Inflation runs in zlib's thread pool, so the budget timer is observed between chunks. (A stored member is copied
    // without yielding; it is bounded by the byte budget instead.)
    const large = await archive([{ name: 'large.bin', data: Buffer.alloc(16 * 1024 * 1024, 7) }], 6)
    expect(await outcome(extractManagedZip(large, ['large.bin'], current))).toBe('resolved:1')
    expect(await outcome(extractManagedZip(large, ['large.bin'], current, budget({ timeoutMs: 1 })))).toBe('archive_limit')
  }, 30_000)
})
