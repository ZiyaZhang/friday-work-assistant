import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const OLD = '1'.repeat(40)
const NEXT = '2'.repeat(40)
const fixtures: { dir: string; server: Server }[] = []

async function fixture(initial: { head?: string; success?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friday-deploy-'))
  const state = join(dir, 'state')
  const bin = join(dir, 'bin')
  mkdirSync(state)
  mkdirSync(bin)
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'node_modules'))
  const put = (name: string, value = '1') => writeFileSync(join(state, name), value)
  const get = (name: string) => existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8').trim() : ''
  const remove = (name: string) => rmSync(join(state, name), { force: true })
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 })
  put('head', initial.head ?? OLD)
  put('remote', NEXT)
  put('gateway-pid', '100')
  put('api-healthy')
  if (initial.success) put('deploy-success.sha', initial.success)
  copyFileSync(new URL('../scripts/deploy-loop.sh', import.meta.url), join(dir, 'scripts/deploy-loop.sh'))
  script('git', `
printf '%s\\n' "$*" >> "$TEST_STATE/git-calls"
case "$1" in
  fetch) test ! -f "$TEST_STATE/fail-fetch" ;;
  rev-parse) if [ "$2" = HEAD ]; then cat "$TEST_STATE/head"; else cat "$TEST_STATE/remote"; fi ;;
  reset) cp "$TEST_STATE/remote" "$TEST_STATE/head" ;;
  cat-file) test ! -f "$TEST_STATE/missing-commit" ;;
  diff)
    if [ "$#" = 2 ]; then test ! -f "$TEST_STATE/dirty";
    elif [ "$#" = 3 ]; then test ! -f "$TEST_STATE/staged";
    else test ! -f "$TEST_STATE/deps-changed"; fi ;;
  log) cat "$TEST_STATE/head" ;;
  *) exit 99 ;;
esac`)
  script('npm', `
printf '%s\\n' "$*" >> "$TEST_STATE/npm-calls"
if [ "$1" = ci ]; then test ! -f "$TEST_STATE/fail-npm"; mkdir -p node_modules;
else test ! -f "$TEST_STATE/fail-build"; fi`)
  script('pgrep', 'cat "$TEST_STATE/gateway-pid"')
  // Keep bounded polling fast; the health request itself is real local HTTP.
  script('sleep', ':')
  writeFileSync(join(dir, 'scripts/run.sh'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_STATE/run-calls"
test ! -f "$TEST_STATE/fail-restart"
if [ ! -f "$TEST_STATE/keep-old-pid" ]; then
  previous=$(cat "$TEST_STATE/gateway-pid")
  printf '%s\\n' "$((previous + 1))" > "$TEST_STATE/gateway-pid"
fi
`)
  let healthRequests = 0
  const server = createServer((req, res) => {
    healthRequests += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: req.url === '/healthz' && get('api-healthy') === '1', ...(get('api-version') ? { version: get('api-version') } : {}) }))
  })
  fixtures.push({ dir, server })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  const env = { ...process.env, HOME: join(dir, 'home'), FRIDAY_HOME: state, TEST_STATE: state,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FRIDAY_API_HOST: '127.0.0.1', FRIDAY_API_PORT: String(address.port) }
  async function once() {
    try {
      const result = await exec('bash', ['scripts/deploy-loop.sh', 'once'], { cwd: dir, env, timeout: 15_000 })
      return { code: 0, output: result.stdout + result.stderr }
    } catch (error) {
      const e = error as Error & { code: number; stdout: string; stderr: string }
      return { code: e.code, output: e.stdout + e.stderr }
    }
  }
  return { put, get, remove, once, healthRequests: () => healthRequests }
}

afterEach(async () => {
  for (const { dir, server } of fixtures.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('deploy-loop shell recovery', () => {
  it('accepts the new gateway only when the version it reports is the commit being deployed', async () => {
    const f = await fixture({ success: OLD })
    f.put('api-version', OLD)
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('报出的版本不是')
    expect(f.get('deploy-success.sha')).toBe('')
    f.put('api-version', NEXT)
    expect((await f.once()).code).toBe(0)
    expect(f.get('deploy-success.sha')).toBe(NEXT)
  })

  it('builds and validates an existing same-HEAD installation once when no success record exists', async () => {
    const f = await fixture({ head: NEXT })
    expect((await f.once()).code).toBe(0)
    expect(f.get('deploy-success.sha')).toBe(NEXT)
    expect(f.get('npm-calls')).toContain('ci --no-audit --no-fund\nrun build')
    expect(f.get('run-calls')).toBe('restart')
    expect(f.healthRequests()).toBe(2)
    expect((await f.once()).code).toBe(0)
    expect(f.get('run-calls')).toBe('restart')
    expect(f.healthRequests()).toBe(2)
  })

  it.each(['fail-build', 'fail-npm'])('retries after %s even though reset already reached the target', async (failure) => {
    const f = await fixture({ success: OLD })
    f.put('deps-changed')
    f.put(failure)
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).not.toContain('部署完成')
    expect(f.get('head')).toBe(NEXT)
    expect(f.get('deploy-success.sha')).toBe('')
    expect(f.get('run-calls')).toBe('')
    f.remove(failure)
    expect((await f.once()).code).toBe(0)
    expect(f.get('deploy-success.sha')).toBe(NEXT)
    expect(f.get('npm-calls').match(/ci --no-audit --no-fund/g)).toHaveLength(2)
  })

  it('does not print success on restart failure and retries on the next invocation', async () => {
    const f = await fixture({ success: OLD })
    f.put('fail-restart')
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('重启失败')
    expect(failed.output).not.toContain('部署完成')
    expect(f.get('deploy-success.sha')).toBe('')
    expect(f.healthRequests()).toBe(0)
    f.remove('fail-restart')
    expect((await f.once()).code).toBe(0)
    expect(f.get('run-calls')).toBe('restart\nrestart')
    expect(f.get('deploy-success.sha')).toBe(NEXT)
  })

  it('requires a new PID instead of accepting the healthy old gateway', async () => {
    const f = await fixture({ success: OLD })
    f.put('keep-old-pid')
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('未通过存活检查')
    expect(f.get('deploy-success.sha')).toBe('')
    f.remove('keep-old-pid')
    expect((await f.once()).code).toBe(0)
    expect(f.get('deploy-success.sha')).toBe(NEXT)
  })

  it('rejects HTTP 200 with ok:false and recovers only after API readiness', async () => {
    const f = await fixture({ success: OLD })
    f.put('api-healthy', '0')
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).not.toContain('部署完成')
    expect(f.get('deploy-success.sha')).toBe('')
    expect(f.healthRequests()).toBe(15)
    f.put('api-healthy')
    expect((await f.once()).code).toBe(0)
    expect(f.get('deploy-success.sha')).toBe(NEXT)
  })

  it('rebuilds the previous good SHA after a failed attempt dirtied installation state', async () => {
    const f = await fixture({ success: OLD })
    f.put('deps-changed')
    f.put('fail-npm')
    expect((await f.once()).code).toBe(1)
    f.put('remote', OLD)
    f.remove('fail-npm')
    expect((await f.once()).code).toBe(0)
    expect(f.get('head')).toBe(OLD)
    expect(f.get('deploy-success.sha')).toBe(OLD)
    expect(f.get('npm-calls').match(/ci --no-audit --no-fund/g)).toHaveLength(2)
  })

  it.each(['dirty', 'staged'])('refuses to reset a checkout with %s tracked changes', async (state) => {
    const f = await fixture({ success: OLD })
    f.put(state)
    const failed = await f.once()
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('拒绝 reset')
    expect(f.get('git-calls')).not.toContain('reset')
    expect(f.get('npm-calls')).toBe('')
    expect(f.get('deploy-success.sha')).toBe(OLD)
  })

  it('leaves the validated installation untouched when fetching fails', async () => {
    const f = await fixture({ success: OLD })
    f.put('fail-fetch')
    expect((await f.once()).code).toBe(1)
    expect(f.get('head')).toBe(OLD)
    expect(f.get('deploy-success.sha')).toBe(OLD)
    expect(f.get('npm-calls')).toBe('')
    expect(f.get('run-calls')).toBe('')
  })
})
