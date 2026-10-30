import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FridayClient } from '../integrations/dsh/lib/transport.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readFileSync: vi.fn(actual.readFileSync), unlinkSync: vi.fn(actual.unlinkSync) }
})
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
const NOW = 1_800_000_000_000, DAY = 86_400_000
const directories: string[] = []
beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync)
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(actual.readFileSync)
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actual.unlinkSync)
})
afterEach(() => { directories.splice(0).forEach(directory => actual.rmSync(directory, { recursive: true, force: true })) })

function fixture() {
  const directory = actual.mkdtempSync(join(tmpdir(), 'friday-storage-'))
  directories.push(directory)
  const create = () => new FridayClient({ directory, relay: 'https://friday.test', now: () => NOW })
  return { directory, create, client: create() }
}
function receipt(directory: string, age = DAY + 1) {
  const path = join(directory, `request-${randomUUID()}.json`)
  actual.writeFileSync(path, '{}')
  actual.utimesSync(path, new Date(NOW - age), new Date(NOW - age))
  return path
}
function disappearAt(operation: 'lstatSync' | 'readFileSync' | 'unlinkSync', path: string) {
  vi.mocked(fs[operation]).mockImplementation((...args: any[]) => {
    if (args[0] === path) actual.unlinkSync(path)
    return (actual[operation] as any)(...args)
  })
}
function failAt(operation: 'lstatSync' | 'readFileSync' | 'unlinkSync', path: string) {
  const error = Object.assign(new Error('Synthetic storage permission failure'), { code: 'EACCES' })
  vi.mocked(fs[operation]).mockImplementation((...args: any[]) => {
    if (args[0] === path) throw error
    return (actual[operation] as any)(...args)
  })
  return error
}

describe('Friday desktop storage across overlapping processes', () => {
  it('reads saved JSON and treats an absent record as missing', () => {
    const { client } = fixture()
    expect(client.read('connection')).toBeNull()
    client.save('connection', { label: 'Synthetic device' })
    expect(client.read('connection')).toEqual({ label: 'Synthetic device' })
  })
  it.each(['lstatSync', 'readFileSync'] as const)('treats a record removed before %s as missing', operation => {
    const { client } = fixture()
    client.save('connection', { label: 'Synthetic device' })
    disappearAt(operation, client.file('connection'))
    expect(client.read('connection')).toBeNull()
  })
  it.each(['lstatSync', 'readFileSync'] as const)('preserves a non-ENOENT read failure from %s', operation => {
    const { client } = fixture()
    client.save('connection', {})
    const error = failAt(operation, client.file('connection'))
    expect(() => client.read('connection')).toThrow(error)
  })
  it('still rejects malformed JSON', () => {
    const { client } = fixture()
    actual.writeFileSync(client.file('connection'), '{')
    expect(() => client.read('connection')).toThrow(SyntaxError)
  })
  it('still refuses to read a symbolic link', () => {
    const { client } = fixture()
    client.save('target', {})
    actual.symlinkSync(client.file('target'), client.file('connection'))
    expect(() => client.read('connection')).toThrow('Invalid Friday storage')
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })
  it('removes an existing record and allows repeated removal', () => {
    const { client } = fixture()
    client.save('pair', {})
    client.remove('pair')
    expect(actual.existsSync(client.file('pair'))).toBe(false)
    expect(() => client.remove('pair')).not.toThrow()
  })
  it('allows a record to disappear just before removal', () => {
    const { client } = fixture()
    client.save('pair', {})
    disappearAt('unlinkSync', client.file('pair'))
    expect(() => client.remove('pair')).not.toThrow()
  })
  it('preserves a non-ENOENT removal failure', () => {
    const { client } = fixture()
    client.save('pair', {})
    const error = failAt('unlinkSync', client.file('pair'))
    expect(() => client.remove('pair')).toThrow(error)
    expect(actual.existsSync(client.file('pair'))).toBe(true)
  })
  it.each(['lstatSync', 'unlinkSync'] as const)('initializes and continues cleanup when a receipt disappears before %s', operation => {
    const { directory, create } = fixture()
    const vanished = receipt(directory), other = receipt(directory)
    disappearAt(operation, vanished)
    expect(() => create()).not.toThrow()
    expect(actual.existsSync(vanished)).toBe(false)
    expect(actual.existsSync(other)).toBe(false)
  })
  it.each(['lstatSync', 'unlinkSync'] as const)('preserves a non-ENOENT cleanup failure from %s', operation => {
    const { directory, create } = fixture()
    const path = receipt(directory), error = failAt(operation, path)
    expect(() => create()).toThrow(error)
    expect(actual.existsSync(path)).toBe(true)
  })
  it('only removes matching regular receipt files older than one day', () => {
    const { directory, client } = fixture()
    const old = receipt(directory), boundary = receipt(directory, DAY), recent = receipt(directory, DAY - 1)
    const nonReceipt = join(directory, 'connection.json'), subdirectory = join(directory, `request-${randomUUID()}.json`)
    const target = join(directory, 'target.json'), link = join(directory, `request-${randomUUID()}.json`)
    actual.writeFileSync(nonReceipt, '{}'); actual.utimesSync(nonReceipt, new Date(NOW - DAY - 1), new Date(NOW - DAY - 1))
    actual.mkdirSync(subdirectory); actual.utimesSync(subdirectory, new Date(NOW - DAY - 1), new Date(NOW - DAY - 1))
    actual.writeFileSync(target, '{}'); actual.utimesSync(target, new Date(NOW - DAY - 1), new Date(NOW - DAY - 1))
    actual.symlinkSync(target, link)
    client.cleanup()
    expect(actual.existsSync(old)).toBe(false)
    for (const path of [boundary, recent, nonReceipt, subdirectory, target, link]) expect(actual.existsSync(path)).toBe(true)
    expect(actual.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
