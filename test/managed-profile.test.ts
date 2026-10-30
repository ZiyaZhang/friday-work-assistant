import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assertManagedProfileDump, prepareManagedProfile } from '../src/acp/managed-profile.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

// The installed minimal tree's service identities. Production checks its real composed dump;
// this fixture exercises hostile overlays without requiring DSH or credentials in unit tests.
function validDump(): string {
  return readFileSync(new URL('../profiles/friday-managed/expected-config.yml', import.meta.url), 'utf8')
}

function fixture(dump = validDump()) {
  const home = mkdtempSync(join(tmpdir(), 'managed-profile-test-'))
  homes.push(home)
  const command = join(home, 'fake-dsh'), record = join(home, 'invocation.json'), dumpFile = join(home, 'dump.yml')
  writeFileSync(dumpFile, dump)
  writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs');
fs.writeFileSync(process.env.RECORD,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,dshHome:process.env.DSH_HOME,provider:process.env.FRIDAY_MANAGED_MODEL_PROVIDER,model:process.env.FRIDAY_MANAGED_MODEL}));
if(process.env.FAIL==='1'){process.stderr.write('SYNTHETIC_SECRET_DO_NOT_LOG');process.exit(1)}
process.stdout.write(fs.readFileSync(process.env.DUMP,'utf8'));
`)
  chmodSync(command, 0o700)
  return { home, record, command, root: join(home, 'managed-root'), env: {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/synthetic/original-home', DSH_HOME: '/synthetic/production-home',
    RECORD: record, DUMP: dumpFile,
  } }
}

describe('managed MCP-only profile admission', () => {
  it('accepts only the installed minimal graph and treats JavaScript tags as inert data', () => {
    expect(() => assertManagedProfileDump(validDump())).not.toThrow()
    const injected = validDump().replace('process.env.FRIDAY_MANAGED_MODEL', '(globalThis.MANAGED_PROFILE_EXECUTED = true)')
    expect(() => assertManagedProfileDump(injected)).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
    expect(Reflect.get(globalThis, 'MANAGED_PROFILE_EXECUTED')).toBeUndefined()
  })

  it.each(['agent-memory', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-subagent', 'skill-filesystem'])(
    'rejects extra %s even if its ID looks disabled or hides in a group', name => {
      for (const suffix of [`\n- id: additional\n  name: '@deepseek-ai/dsh-${name}'\n  disabled: true`,
        `\n- group: true\n  config:\n    - id: additional\n      name: '@deepseek-ai/dsh-${name}'`]) {
        expect(() => assertManagedProfileDump(validDump() + suffix)).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
      }
    })

  it('rejects re-enabled producers, duplicate identities, dynamic modules and extra prompt assembly', () => {
    const dump = validDump()
    for (const bad of [
      dump.replace("name: '@deepseek-ai/dsh-tool-bash-persistent'\n  disabled: true", "name: '@deepseek-ai/dsh-tool-bash-persistent'\n  disabled: false"),
      dump.replace('- id: acp\n', '- id: tools\n'),
      dump.replace("name: '@deepseek-ai/dsh-agent'", "name: !!js process.env.UNKNOWN_PLUGIN"),
      dump.replace('includeRuntimeContext: false', 'includeRuntimeContext: true'),
      dump.replace('agents: []', 'agents: [unreviewed-agent]'),
      dump.replace("dshHomePath('sessions')", "'/old/history'"),
      dump.replace('mode: native', 'mode: native\n    extraTools: [shell]'),
      dump.replace('apiKeyEnv: DEEPSEEK_API_KEY', "apiKeyEnv: DEEPSEEK_API_KEY\n    reviewCanary: !!js (globalThis.MANAGED_PROFILE_EXECUTED = true)"),
      dump.replace('apiKeyEnv: DEEPSEEK_API_KEY', 'apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: https://synthetic.invalid/anthropic'),
      dump.replace("name: '@deepseek-ai/dsh-session-title'", "name: '@deepseek-ai/dsh-session-title'\n  inject: [unreviewedService]"),
      dump.replace('model: !!js process.env.FRIDAY_MANAGED_MODEL', 'model: { expression: process.env.FRIDAY_MANAGED_MODEL }'),
    ]) expect(() => assertManagedProfileDump(bad)).toThrow(expect.objectContaining({ code: 'config_mismatch' }))
    expect(Reflect.get(globalThis, 'MANAGED_PROFILE_EXECUTED')).toBeUndefined()
  })

  it('keeps malformed dumps and subprocess stderr out of errors, and cleans failed homes', async () => {
    expect(() => assertManagedProfileDump('- name: [SYNTHETIC_SECRET_DO_NOT_LOG')).toThrow(expect.objectContaining({ code: 'invalid_dump' }))
    const t = fixture()
    await expect(prepareManagedProfile({ ...t, env: { ...t.env, FAIL: '1' }, provider: 'deepseek-official', model: 'the-current-model' }))
      .rejects.toMatchObject({ code: 'prepare_failed', message: '无法准备或核验受管执行 profile。' })
    expect(readdirSync(t.root)).toEqual([])
  })

  it('creates separate owned homes, preserves the exact route and supplies a usable spawn transport', async () => {
    const t = fixture()
    const first = await prepareManagedProfile({ ...t, provider: 'deepseek-official', model: 'the-current-model' })
    writeFileSync(t.env.DUMP, '# patched by /different/temporary/home/cordis.patch.yml\n' + validDump())
    const second = await prepareManagedProfile({ ...t, provider: 'deepseek-official', model: 'the-current-model' })
    expect(first.home).not.toBe(second.home)
    expect(first.profileDigest).toBe(second.profileDigest)
    expect(JSON.parse(readFileSync(t.record, 'utf8'))).toEqual({ args: ['--profile', 'friday-managed', '--dump-config'],
      cwd: join(second.home, 'workspace'), home: second.home, dshHome: second.home, provider: 'deepseek-official', model: 'the-current-model' })
    expect(first.transport).toMatchObject({ kind: 'spawn', command: t.command, args: ['--profile', 'friday-managed'],
      cwd: join(first.home, 'workspace'), env: { HOME: first.home, DSH_HOME: first.home, FRIDAY_MANAGED_MODEL: 'the-current-model' } })
    expect(readdirSync(first.home).sort()).toEqual(['profiles', 'workspace'])
    expect(readdirSync(join(first.home, 'workspace'))).toEqual([])
    expect(JSON.parse(readFileSync(join(first.home, 'profiles/friday-managed/package.json'), 'utf8')).dsh.profile.bundles)
      .toEqual(['@deepseek-ai/dsh-sdk-minimal'])
    first.close(); first.close()
    expect(existsSync(first.home)).toBe(false)
    expect(existsSync(second.home)).toBe(true)
    second.close()
  })

  it('cleans a valid process output that fails admission rather than returning a runnable profile', async () => {
    const t = fixture(validDump().replace('includeHarnessIdentity: false', 'includeHarnessIdentity: true'))
    await expect(prepareManagedProfile({ ...t, provider: 'deepseek-official', model: 'current' })).rejects.toMatchObject({ code: 'config_mismatch' })
    expect(readdirSync(t.root)).toEqual([])
  })

  it('does not silently switch an unsupported provider or an unspecified model', async () => {
    const t = fixture()
    await expect(prepareManagedProfile({ ...t, provider: 'other-provider', model: 'current' })).rejects.toMatchObject({ code: 'unsupported_provider' })
    await expect(prepareManagedProfile({ ...t, provider: 'deepseek-official', model: ' ' })).rejects.toMatchObject({ code: 'invalid_model' })
    expect(existsSync(t.root)).toBe(false)
    expect(existsSync(t.record)).toBe(false)
  })
})
