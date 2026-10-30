import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuiltinSkillReader, prepareBuiltinSkillBundle } from '../src/core/builtin-skill-bundle.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function home() { const path = mkdtempSync(join(tmpdir(), 'friday-builtin-reader-')); homes.push(path); return path }
function fixture() {
  const root = home(), source = join(root, 'source'), bundles = join(root, 'bundles')
  mkdirSync(join(source, 'example', 'references'), { recursive: true })
  writeFileSync(join(source, 'example', 'SKILL.md'), '---\nname: example\ndescription: "A short: description"\n---\n\nRead references/guide.md.\n')
  writeFileSync(join(source, 'example', 'references', 'guide.md'), '合成原文\nKeep the negation: do not invent a result.🙂\n')
  const bundle = prepareBuiltinSkillBundle(source, bundles), reader = new BuiltinSkillReader(bundle)
  return { root, source, bundles, bundle, reader }
}

describe('host-pinned built-in skill reading without the native loader', () => {
  it('catalogs all deployed skills and loads every bundled resource with its actual bytes and digest', () => {
    const source = resolve('skills'), bundle = prepareBuiltinSkillBundle(source, join(home(), 'bundles'))
    const reader = new BuiltinSkillReader(bundle), catalog = reader.catalog(bundle.digest)
    expect(catalog.builtinDigest).toBe(bundle.digest)
    expect(catalog.skills.map(skill => skill.name)).toEqual(bundle.names)
    // 守的是"一个都不漏"，不是"正好 21 个"——钉死数字的话，每加一个技能都得回来改这一行，
    // 而它并没有在守什么。真正该守的是 skills/ 目录里的每一个都进了 bundle。
    const onDisk = readdirSync(source, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    expect([...catalog.skills.map(skill => skill.name)].sort()).toEqual(onDisk)
    expect(catalog.skills.some(skill => skill.resources.some(resource => resource.startsWith('references/')))).toBe(true)
    for (const skill of catalog.skills) {
      expect(skill.description.trim()).not.toBe('')
      expect(skill.resources).toContain('SKILL.md')
      for (const resource of skill.resources) {
        const bytes = readFileSync(join(source, skill.name, resource))
        expect(reader.load(skill.name, resource, bundle.digest)).toEqual({ name: skill.name, resource, content: bytes.toString('utf8'),
          contentDigest: createHash('sha256').update(bytes).digest('hex'), builtinDigest: bundle.digest })
      }
    }
    expect(JSON.stringify(catalog)).not.toContain(bundle.directory)
  })

  it('keeps the exact old version readable after a source update and rejects another Run digest', () => {
    const t = fixture(), original = t.reader.load('example', undefined, t.bundle.digest)
    writeFileSync(join(t.source, 'example', 'references', 'guide.md'), 'new version')
    const next = prepareBuiltinSkillBundle(t.source, t.bundles)
    expect(next.digest).not.toBe(t.bundle.digest)
    expect(t.reader.load('example', undefined, t.bundle.digest)).toEqual(original)
    expect(t.reader.load('example', 'references/guide.md', t.bundle.digest).content).not.toBe('new version')
    for (const digest of [next.digest, '', 'model-claimed-version']) {
      expect(() => t.reader.catalog(digest)).toThrow(expect.objectContaining({ code: 'version_mismatch' }))
      expect(() => t.reader.load('example', 'references/guide.md', digest)).toThrow(expect.objectContaining({ code: 'version_mismatch' }))
    }
    expect(new BuiltinSkillReader(next).load('example', 'references/guide.md', next.digest).content).toBe('new version')
  })

  it('uses its captured directory/digest, derives names from the verified files and returns detached catalog data', () => {
    const t = fixture()
    const mutable = { ...t.bundle, names: ['forged-name'] }, reader = new BuiltinSkillReader(mutable)
    mutable.directory = t.source
    mutable.digest = 'a'.repeat(64)
    const catalog = reader.catalog(t.bundle.digest)
    expect(catalog.skills.map(skill => skill.name)).toEqual(['example'])
    catalog.skills[0]!.name = 'changed'
    catalog.skills[0]!.resources.push('../outside')
    expect(reader.catalog(t.bundle.digest).skills).toEqual([{ name: 'example', description: 'A short: description',
      resources: ['references/guide.md', 'SKILL.md'] }])
  })

  it.each(['changed', 'deleted', 'added'] as const)('checks the whole file collection on every call, including an unrelated %s resource', mutation => {
    const t = fixture(), reference = join(t.bundle.directory, 'example', 'references', 'guide.md')
    if (mutation === 'changed') writeFileSync(reference, 'tampered reference')
    if (mutation === 'deleted') rmSync(reference)
    if (mutation === 'added') writeFileSync(join(t.bundle.directory, 'extra.txt'), 'unversioned extra')
    expect(() => t.reader.load('example', undefined, t.bundle.digest)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(() => t.reader.catalog(t.bundle.digest)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(() => new BuiltinSkillReader(t.bundle)).toThrow(expect.objectContaining({ code: 'content_changed' }))
  })

  it.each(['root', 'skill', 'reference-directory', 'reference-file'] as const)('rejects a %s symlink even when it points to byte-identical original resources', where => {
    const t = fixture()
    const target = where === 'root' ? t.bundle.directory : where === 'skill' ? join(t.bundle.directory, 'example')
      : where === 'reference-directory' ? join(t.bundle.directory, 'example', 'references')
        : join(t.bundle.directory, 'example', 'references', 'guide.md')
    const outside = join(t.root, 'same-bytes-outside')
    renameSync(target, outside)
    symlinkSync(outside, target)
    expect(() => t.reader.load('example', undefined, t.bundle.digest)).toThrow(expect.objectContaining({ code: 'content_changed' }))
    expect(() => t.reader.catalog(t.bundle.digest)).toThrow(expect.objectContaining({ code: 'content_changed' }))
  })

  it.each(['/etc/passwd', '../example/SKILL.md', 'references/../SKILL.md', './SKILL.md', 'references//guide.md',
    'references\\guide.md', 'file:///etc/passwd', 'C:\\secret', 'references/guide.md\0', ''])('rejects a noncanonical resource path %j', resource => {
    const t = fixture()
    expect(() => t.reader.load('example', resource, t.bundle.digest)).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  })

  it('does not fall back to arbitrary folders or another skill when a logical resource is missing', () => {
    const t = fixture()
    for (const name of ['../example', '/example', 'example/SKILL.md', 'Example']) {
      expect(() => t.reader.load(name, undefined, t.bundle.digest)).toThrow(expect.objectContaining({ code: 'invalid_request' }))
    }
    expect(() => t.reader.load('other-skill', undefined, t.bundle.digest)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => t.reader.load('example', 'references/missing.md', t.bundle.digest)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => t.reader.load('example', 'references', t.bundle.digest)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('parses multiline descriptions but never executes YAML tags or leaks invalid frontmatter in errors', () => {
    const t = fixture()
    writeFileSync(join(t.source, 'example', 'SKILL.md'), '---\nname: example\ndescription: >-\n  First line\n  second line\n---\nBody\n')
    let bundle = prepareBuiltinSkillBundle(t.source, t.bundles)
    expect(new BuiltinSkillReader(bundle).catalog(bundle.digest).skills[0]?.description).toBe('First line second line')
    writeFileSync(join(t.source, 'example', 'SKILL.md'), '---\nname: example\ndescription: !!js "globalThis.BUILTIN_READER_CANARY = true"\n---\nBody\n')
    bundle = prepareBuiltinSkillBundle(t.source, t.bundles)
    let error: unknown
    try { new BuiltinSkillReader(bundle).catalog(bundle.digest) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'invalid_bundle' })
    expect(String(error)).not.toContain('BUILTIN_READER_CANARY')
    expect(Reflect.get(globalThis, 'BUILTIN_READER_CANARY')).toBeUndefined()
  })

  it('preserves plain SKILL.md compatibility and rejects invalid UTF-8 rather than returning replacement text', () => {
    const t = fixture()
    writeFileSync(join(t.source, 'example', 'SKILL.md'), 'Plain skill without frontmatter')
    writeFileSync(join(t.source, 'example', 'references', 'guide.md'), Buffer.from([0xc3, 0x28]))
    const bundle = prepareBuiltinSkillBundle(t.source, t.bundles), reader = new BuiltinSkillReader(bundle)
    expect(reader.catalog(bundle.digest).skills[0]?.description).toBe('')
    expect(reader.load('example', undefined, bundle.digest).content).toBe('Plain skill without frontmatter')
    expect(() => reader.load('example', 'references/guide.md', bundle.digest)).toThrow(expect.objectContaining({ code: 'invalid_bundle' }))
  })
})
