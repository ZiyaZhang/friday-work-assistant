import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { SKILL_NAME_RE } from './skills.js'

export interface BuiltinSkillBundle { directory: string; digest: string; names: string[] }
interface Resource { path: string; bytes: Buffer }

function resources(root: string, prefix = ''): Resource[] {
  if (!lstatSync(join(root, prefix)).isDirectory()) throw new Error('内置技能资源必须位于普通目录')
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) return resources(root, path)
      if (!entry.isFile()) throw new Error(`内置技能资源必须是普通文件：${path}`)
      // Re-check the opened file rather than following a link swapped after readdir.
      const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`内置技能资源必须是普通文件：${path}`)
        return [{ path, bytes: readFileSync(fd) }]
      } finally { closeSync(fd) }
    })
}

function digestOf(files: Resource[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(JSON.stringify([file.path, file.bytes.length])).update('\n').update(file.bytes)
  return hash.digest('hex')
}

/** One runtime uses one exact built-in bundle, including referenced files. Not an OS boundary. */
export function prepareBuiltinSkillBundle(source: string, bundlesRoot: string): BuiltinSkillBundle {
  const files = resources(source)
  const digest = digestOf(files)
  const directory = join(bundlesRoot, digest)
  if (existsSync(directory)) {
    if (digestOf(resources(directory)) !== digest) throw new Error('内置技能版本内容已改变，请核对部署文件')
  } else {
    mkdirSync(bundlesRoot, { recursive: true })
    const staging = mkdtempSync(join(bundlesRoot, '.staging-'))
    try {
      for (const file of files) {
        const path = join(staging, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.bytes)
      }
      renameSync(staging, directory)
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  return { directory, digest, names: files.filter(file => /^[^/]+\/SKILL\.md$/.test(file.path)).map(file => file.path.split('/')[0]!) }
}

export interface BuiltinSkillCatalog {
  builtinDigest: string
  skills: { name: string; description: string; resources: string[] }[]
}
export interface BuiltinSkillResource {
  name: string
  resource: string
  content: string
  contentDigest: string
  builtinDigest: string
}
export class BuiltinSkillReadError extends Error {
  constructor(readonly code: 'invalid_bundle' | 'invalid_request' | 'version_mismatch' | 'content_changed' | 'not_found') {
    super({
      invalid_bundle: '内置技能目录或元数据无效。',
      invalid_request: '内置技能名称或资源路径无效。',
      version_mismatch: '本次执行的内置技能版本不匹配。',
      content_changed: '内置技能版本文件缺失或已变化，请核对部署文件。',
      not_found: '该版本中没有这个内置技能或资源。',
    }[code])
    this.name = 'BuiltinSkillReadError'
  }
}

/** Host-side reading of one immutable bundle; no native loader or arbitrary file API.
 * expectedDigest must come from the host's actual RunSkillSet, never model input.
 * Every result uses the exact bytes included in that call's whole-bundle verification.
 * This detects changed resources; it is not an OS isolation boundary.
 */
export class BuiltinSkillReader {
  private readonly directory: string
  private readonly canonicalDirectory: string
  private readonly digest: string

  constructor(bundle: Pick<BuiltinSkillBundle, 'directory' | 'digest'>) {
    if (!isAbsolute(bundle.directory) || !/^[a-f0-9]{64}$/.test(bundle.digest)) throw new BuiltinSkillReadError('invalid_bundle')
    this.directory = resolve(bundle.directory)
    this.digest = bundle.digest
    try {
      if (!lstatSync(this.directory).isDirectory()) throw new Error('not a directory')
      this.canonicalDirectory = realpathSync(this.directory)
    } catch { throw new BuiltinSkillReadError('invalid_bundle') }
    this.snapshot(this.digest)
  }

  catalog(expectedDigest: string): BuiltinSkillCatalog {
    const files = this.snapshot(expectedDigest)
    return { builtinDigest: this.digest, skills: files.filter(file => /^[^/]+\/SKILL\.md$/.test(file.path)).map(file => {
      const name = file.path.split('/')[0]!
      if (!SKILL_NAME_RE.test(name)) throw new BuiltinSkillReadError('invalid_bundle')
      return { name, description: this.description(file, name),
        resources: files.filter(resource => resource.path.startsWith(`${name}/`)).map(resource => resource.path.slice(name.length + 1)) }
    }) }
  }

  load(name: string, resource: string | undefined, expectedDigest: string): BuiltinSkillResource {
    resource ??= 'SKILL.md'
    if (!SKILL_NAME_RE.test(name) || !resource || /[\\\x00-\x1f\x7f:]/.test(resource)
      || resource.split('/').some(part => !part || part === '.' || part === '..')) throw new BuiltinSkillReadError('invalid_request')
    const files = this.snapshot(expectedDigest)
    if (!files.some(file => file.path === `${name}/SKILL.md`)) throw new BuiltinSkillReadError('not_found')
    const file = files.find(file => file.path === `${name}/${resource}`)
    if (!file) throw new BuiltinSkillReadError('not_found')
    return { name, resource, content: this.text(file), contentDigest: createHash('sha256').update(file.bytes).digest('hex'), builtinDigest: this.digest }
  }

  private snapshot(expectedDigest: string): Resource[] {
    if (expectedDigest !== this.digest) throw new BuiltinSkillReadError('version_mismatch')
    try {
      if (!lstatSync(this.directory).isDirectory() || realpathSync(this.directory) !== this.canonicalDirectory) throw new Error('directory changed')
      const files = resources(this.directory)
      if (digestOf(files) !== this.digest || !lstatSync(this.directory).isDirectory()
        || realpathSync(this.directory) !== this.canonicalDirectory) throw new Error('bundle changed')
      return files
    } catch { throw new BuiltinSkillReadError('content_changed') }
  }

  private text(file: Resource): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) }
    catch { throw new BuiltinSkillReadError('invalid_bundle') }
  }

  private description(file: Resource, name: string): string {
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(this.text(file))
    if (!header) return '' // prepare also supports plain SKILL.md files.
    try {
      const parsed = parseDocument(header[1]!)
      if (parsed.errors.length || parsed.warnings.length) throw new Error('invalid yaml')
      const metadata: unknown = parsed.toJS({ maxAliasCount: 100 })
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid metadata')
      const row = metadata as Record<string, unknown>
      if (row.name !== undefined && row.name !== name || typeof row.description !== 'string') throw new Error('invalid metadata')
      return row.description
    } catch { throw new BuiltinSkillReadError('invalid_bundle') }
  }
}

/** Applied after the deployment's base patch; custom methods come through the Space-bound MCP. */
export function builtinSkillProfilePatch(bundle: BuiltinSkillBundle): string {
  return `\n- id: skill-filesystem\n  config:\n    includeDefaultRoots: false\n    customSkillDirs: []\n    bundledSkillDir: ${JSON.stringify(bundle.directory)}\n    watch: false\n`
}

export class BuiltinSkillProfileError extends Error {
  constructor(readonly code: 'invalid_dump' | 'duplicate_provider' | 'config_mismatch') {
    super({
      invalid_dump: '无法核验 DSH 技能配置：有效配置输出无效。',
      duplicate_provider: 'DSH 配置含额外文件系统技能提供方，请移除后重试。',
      config_mismatch: 'DSH 技能配置与受管内置目录不一致，请检查保留配置或全局覆盖。',
    }[code])
    this.name = 'BuiltinSkillProfileError'
  }
}

/**
 * Check the actual `dsh <profile> --dump-config` composition, including the home
 * patch applied after the profile. Parse !!js as inert data, never evaluate it.
 * This checks the declared filesystem provider, not arbitrary plugin code/OS access.
 * Dump text can contain credentials: no raw config or parser error escapes here.
 */
export function assertBuiltinSkillProfileDump(dump: string, bundle: Pick<BuiltinSkillBundle, 'directory'>): void {
  let tree: unknown
  try {
    if (Buffer.byteLength(dump) > 16 * 1024 * 1024) throw new Error('too large')
    const document = parseDocument(dump, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ unevaluatedJs: value }) }] })
    if (document.errors.length || document.warnings.length) throw new Error('invalid yaml')
    tree = document.toJS({ maxAliasCount: 100 })
  } catch { throw new BuiltinSkillProfileError('invalid_dump') }
  const found: { entry: Record<string, unknown>; active: boolean }[] = []
  const ancestors = new Set<unknown>()
  let count = 0
  const visit = (rows: unknown, parentActive: boolean): void => {
    if (!Array.isArray(rows) || ancestors.has(rows)) throw new BuiltinSkillProfileError('invalid_dump')
    ancestors.add(rows)
    for (const row of rows) {
      if (++count > 10_000 || !row || typeof row !== 'object' || Array.isArray(row)) throw new BuiltinSkillProfileError('invalid_dump')
      const entry = row as Record<string, unknown>
      const active = parentActive && (entry.disabled === undefined || entry.disabled === false)
      if (entry.group === true) {
        visit(entry.config, active)
        continue
      }
      // A dynamic module name cannot be proved not to mount another provider.
      if (typeof entry.name !== 'string') throw new BuiltinSkillProfileError('config_mismatch')
      if (entry.id === 'skill-filesystem' || entry.name === '@deepseek-ai/dsh-skill-filesystem' || entry.name.startsWith('@deepseek-ai/dsh-skill-filesystem/')) found.push({ entry, active })
    }
    ancestors.delete(rows)
  }
  visit(tree, true)
  if (found.length > 1) throw new BuiltinSkillProfileError('duplicate_provider')
  const provider = found[0], entry = provider?.entry, config = entry?.config
  if (!provider?.active || entry?.id !== 'skill-filesystem' || entry.name !== '@deepseek-ai/dsh-skill-filesystem'
    || !config || typeof config !== 'object' || Array.isArray(config)) throw new BuiltinSkillProfileError('config_mismatch')
  const c = config as Record<string, unknown>
  if (c.includeDefaultRoots !== false || !Array.isArray(c.customSkillDirs) || c.customSkillDirs.length !== 0
    || c.bundledSkillDir !== bundle.directory || c.watch !== false) throw new BuiltinSkillProfileError('config_mismatch')
}
