import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assertBuiltinSkillProfileDump, prepareBuiltinSkillBundle } from '../src/core/builtin-skill-bundle.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-skill-bundle-'))
  homes.push(home)
  const source = join(home, 'source'), target = join(home, 'bundles')
  mkdirSync(join(source, 'example', 'references'), { recursive: true })
  writeFileSync(join(source, 'example', 'SKILL.md'), 'Use [guide](references/guide.md)')
  writeFileSync(join(source, 'example', 'references', 'guide.md'), 'original guide')
  return { home, source, target }
}

describe('versioned built-in skill resources', () => {
  it('keeps old runtime resources intact when a referenced file changes and reuses the exact version on restart', () => {
    const t = fixture()
    const first = prepareBuiltinSkillBundle(t.source, t.target)
    expect(first.names).toEqual(['example'])
    expect(prepareBuiltinSkillBundle(t.source, t.target)).toEqual(first)
    writeFileSync(join(t.source, 'example', 'references', 'guide.md'), 'new guide')
    const second = prepareBuiltinSkillBundle(t.source, t.target)
    expect(second.digest).not.toBe(first.digest)
    expect(readFileSync(join(first.directory, 'example', 'references', 'guide.md'), 'utf8')).toBe('original guide')
    expect(readFileSync(join(second.directory, 'example', 'references', 'guide.md'), 'utf8')).toBe('new guide')
    expect(readdirSync(t.target).sort()).toEqual([first.digest, second.digest].sort())
  })

  it('rejects modified stored versions and symlinks instead of loading an unversioned external file', () => {
    const t = fixture(), bundle = prepareBuiltinSkillBundle(t.source, t.target)
    writeFileSync(join(bundle.directory, 'example', 'SKILL.md'), 'changed after publishing')
    expect(() => prepareBuiltinSkillBundle(t.source, t.target)).toThrow('版本内容已改变')
    symlinkSync(join(t.home, 'outside'), join(t.source, 'example', 'external'))
    expect(() => prepareBuiltinSkillBundle(t.source, t.target)).toThrow('普通文件')
  })
})

describe('actual DSH config-dump admission', () => {
  const directory = '/synthetic/bundles/exact-version'
  const provider = { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
    includeDefaultRoots: false, customSkillDirs: [], bundledSkillDir: directory, watch: false,
  } }
  const validate = (entries: unknown) => assertBuiltinSkillProfileDump(JSON.stringify(entries), { directory })

  it('accepts the exact composed provider without evaluating retained model/persona !!js expressions', () => {
    const dump = `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    model: !!js '(globalThis.C3_PROFILE_MUST_NOT_EXECUTE = true)'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaSuffix: retained custom persona
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs: []
    bundledSkillDir: ${directory}
    watch: false
`
    expect(() => assertBuiltinSkillProfileDump(dump, { directory })).not.toThrow()
    expect(Reflect.get(globalThis, 'C3_PROFILE_MUST_NOT_EXECUTE')).toBeUndefined()
  })

  it('rejects an additional filesystem provider in a nested group rather than merely finding the managed one', () => {
    const extra = { ...provider, id: 'old-custom-filesystem', config: { providerName: 'another', includeDefaultRoots: true } }
    expect(() => validate([provider, { group: true, config: [extra] }])).toThrow(expect.objectContaining({ code: 'duplicate_provider' }))
  })

  it.each([
    { includeDefaultRoots: true }, { customSkillDirs: ['/synthetic/unmanaged'] },
    { bundledSkillDir: '/synthetic/other-version' }, { watch: true },
    { watch: { unevaluatedJs: 'false' } },
  ])('rejects a late global/profile override: %j', patch => {
    expect(() => validate([{ ...provider, config: { ...provider.config, ...patch } }])).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
  })

  it('does not accept a disabled or conditionally active provider, including a disabled ancestor', () => {
    for (const entries of [[{ ...provider, disabled: true }], [{ ...provider, disabled: { unevaluatedJs: 'false' } }], [{ group: true, disabled: true, config: [provider] }], []]) {
      expect(() => validate(entries)).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
    }
  })

  it('rejects dynamic plugin names and dynamic skill roots without evaluating them', () => {
    const dynamic = `- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    includeDefaultRoots: false\n    customSkillDirs: []\n    bundledSkillDir: !!js 'process.env.C3_SECRET'\n    watch: false\n`
    expect(() => assertBuiltinSkillProfileDump(dynamic, { directory })).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
    expect(() => validate([provider, { id: 'dynamic', name: { unevaluatedJs: 'provider module' } }])).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
  })

  it('rejects invalid YAML and recursive groups with a fixed error that contains no dump contents', () => {
    for (const dump of ['- config: [C3_SECRET_DO_NOT_LOG', '- &loop\n  group: true\n  config: [*loop]']) {
      let error: unknown
      try { assertBuiltinSkillProfileDump(dump, { directory }) } catch (caught) { error = caught }
      expect(error).toMatchObject({ code: 'invalid_dump' })
      expect(String(error)).not.toContain('C3_SECRET_DO_NOT_LOG')
    }
  })
})
