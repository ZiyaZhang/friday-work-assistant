import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseDocument } from 'yaml'
import type { AcpTransport } from './runtime.js'

const execFileAsync = promisify(execFile)
const profileSource = fileURLToPath(new URL('../../profiles/friday-managed/', import.meta.url))
const profile = 'friday-managed'

export class ManagedProfileError extends Error {
  constructor(readonly code: 'invalid_dump' | 'config_mismatch' | 'unsupported_provider' | 'invalid_model' | 'prepare_failed') {
    super({ invalid_dump: '受管执行配置无法解析。', config_mismatch: '受管执行配置不符合已验证的工具与上下文范围。',
      unsupported_provider: '受管执行 profile 尚未验证该模型提供方。', invalid_model: '受管执行需要明确的当前模型。',
      prepare_failed: '无法准备或核验受管执行 profile。' }[code])
    this.name = 'ManagedProfileError'
  }
}

class InertExpression { constructor(readonly expression: string) {} }

function configDigest(dump: string): string {
  try {
    if (Buffer.byteLength(dump) > 16 * 1024 * 1024) throw new Error()
    const doc = parseDocument(dump, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => new InertExpression(expression) }] })
    if (doc.errors.length || doc.warnings.length) throw new Error()
    const ancestors = new Set<unknown>()
    const encode = (value: unknown): unknown => {
      if (value instanceof InertExpression) return ['js', value.expression]
      if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error()
        return ['value', value]
      }
      if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error()
      ancestors.add(value)
      const result = Array.isArray(value) ? ['array', value.map(encode)]
        : ['object', Object.keys(value).sort().map(key => [key, encode((value as Record<string, unknown>)[key])])]
      ancestors.delete(value)
      return result
    }
    return createHash('sha256').update(JSON.stringify(encode(doc.toJS({ maxAliasCount: 100 })))).digest('hex')
  } catch { throw new ManagedProfileError('invalid_dump') }
}

/** Pin the full audited graph, config, inject and inert JS; comments/key order do not affect identity. */
export function assertManagedProfileDump(dump: string): string {
  const digest = configDigest(dump)
  const expected = configDigest(readFileSync(join(profileSource, 'expected-config.yml'), 'utf8'))
  if (digest !== expected) throw new ManagedProfileError('config_mismatch')
  return digest
}

export interface PreparedManagedProfile {
  home: string
  profileDigest: string
  transport: Extract<AcpTransport, { kind: 'spawn' }>
  /** The caller must first stop its runtime. This only removes the owned temporary home. */
  close(): void
}

/** No production home/config is read; env must be the host's existing model/environment allowlist. */
export async function prepareManagedProfile(input: {
  command: string; env: Record<string, string>; root: string; provider: string; model: string
}): Promise<PreparedManagedProfile> {
  // sdk-minimal installs this adapter only. Never silently change the caller's provider.
  if (input.provider !== 'deepseek-official') throw new ManagedProfileError('unsupported_provider')
  if (!input.model.trim() || input.model !== input.model.trim() || input.model.length > 200) throw new ManagedProfileError('invalid_model')
  mkdirSync(input.root, { recursive: true, mode: 0o700 })
  const home = mkdtempSync(join(realpathSync(input.root), 'managed-'))
  try {
    const directory = join(home, 'profiles', profile), cwd = join(home, 'workspace')
    mkdirSync(directory, { recursive: true })
    mkdirSync(cwd)
    const hash = createHash('sha256')
    for (const name of ['package.json', 'cordis.patch.yml']) {
      const source = join(profileSource, name)
      hash.update(name).update(readFileSync(source))
      copyFileSync(source, join(directory, name))
    }
    const env = { ...input.env, HOME: home, DSH_HOME: home, DSH_TELEMETRY_MODE: 'OFF', DSH_TELEMETRY_DISABLED: '1',
      FRIDAY_MANAGED_MODEL_PROVIDER: input.provider, FRIDAY_MANAGED_MODEL: input.model }
    const { stdout } = await execFileAsync(input.command, ['--profile', profile, '--dump-config'], {
      cwd, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    })
    const configDigest = assertManagedProfileDump(stdout)
    const profileDigest = hash.update(configDigest).update(JSON.stringify([input.provider, input.model])).digest('hex')
    return { home, profileDigest, transport: { kind: 'spawn', command: input.command, args: ['--profile', profile], env, cwd },
      close: () => rmSync(home, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    if (error instanceof ManagedProfileError) throw error
    throw new ManagedProfileError('prepare_failed')
  }
}
