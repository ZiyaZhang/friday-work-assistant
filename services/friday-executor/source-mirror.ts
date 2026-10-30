import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export type SourceMirrorErrorCode = 'repository_not_allowed' | 'invalid_revision' | 'source_mirror_not_private'
  | 'source_mirror_unavailable' | 'source_credential_unavailable' | 'source_fetch_failed' | 'source_fetch_timeout'
  | 'source_revision_unavailable' | 'source_fetch_cancelled'
export const SOURCE_MIRROR_ERROR_CODES: ReadonlySet<string> = new Set<SourceMirrorErrorCode>(['repository_not_allowed',
  'invalid_revision', 'source_mirror_not_private', 'source_mirror_unavailable', 'source_credential_unavailable',
  'source_fetch_failed', 'source_fetch_timeout', 'source_revision_unavailable', 'source_fetch_cancelled'])

/** The message is only the fixed code: never a remote URL, proxy, header or Git stderr. */
export class SourceMirrorError extends Error {
  constructor(readonly code: SourceMirrorErrorCode) { super(code); this.name = 'SourceMirrorError' }
}

export interface SourceMirrorEvent {
  event: 'source_mirror'
  repo: string
  baseSha: string
  outcome: 'hit' | 'fetched' | 'failed'
  code?: SourceMirrorErrorCode
  durationMs: number
}

export interface SourceMirrorConfig {
  /** Private directory; each repository is `<root>/<lowercase owner>/<lowercase repo>.git` (bare, shallow). */
  root: string
  /** HTTPS URL containing `{repo}` (replaced by the allowlisted `owner/repo`), or a prefix that gets `/<owner>/<repo>.git`. */
  remote: string
  allowedRepos: readonly string[]
  /** Relay route: the relay's RELAY_READ_TOKEN, sent only as `x-friday-relay-token`. No Authorization
   * is sent unless githubTokenFile is also set; the relay adds its own GitHub read credential. */
  relayTokenFile?: string
  /** Direct GitHub route: a GitHub read credential, sent only as HTTP Basic `x-access-token`. */
  githubTokenFile?: string
  /** HTTP(S) proxy used only for the remote. */
  proxy?: string
  /** Whole `git fetch` limit; default 5 minutes. */
  fetchTimeoutMs?: number
  gitPath?: string
  /** Tests may use local transports. The service entry point never sets this; production is HTTPS only. */
  remoteProtocols?: readonly ('https:' | 'http:' | 'file:')[]
  log?: (event: SourceMirrorEvent) => void
}

const SHA = /^[a-f0-9]{40}$/, REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SECRET = /^[\x21-\x7e]{16,4096}$/, REF_PREFIX = 'refs/friday/sources/'
const LOCAL_TIMEOUT = 30_000, TERMINATE_GRACE = 2_000, DEFAULT_FETCH_TIMEOUT = 5 * 60_000
const invalid = () => new Error('invalid_source_mirror_configuration')
type GitResult = { code: number | null; stdout: string; timedOut: boolean }

/** Provider-side cache of commits fetched by SHA with depth 1. Credentials and the
 * remote stay in this process and its Git children (environment, not argv); the
 * mirror is never mounted into a container. One provider process owns the root
 * (the unit's flock), and operations on one repository run one at a time. */
export class SourceMirror {
  private readonly root: string
  private readonly template: string
  private readonly protocol: string
  private readonly allowed: readonly string[]
  private readonly fetchTimeoutMs: number
  private readonly gitPath: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly config: SourceMirrorConfig) {
    const protocols = config.remoteProtocols ?? ['https:']
    if (typeof config.root !== 'string' || !isAbsolute(config.root) || /[\0\r\n]/.test(config.root) ||
      !Array.isArray(config.allowedRepos) || config.allowedRepos.length === 0 ||
      config.allowedRepos.some(repo => typeof repo !== 'string' || !REPO.test(repo)) ||
      [config.relayTokenFile, config.githubTokenFile, config.gitPath].some(path => path !== undefined &&
        (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)))) throw invalid()
    const timeout = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60 * 60_000) throw invalid()
    this.root = resolve(config.root)
    this.template = remoteTemplate(config.remote, protocols)
    const probe = new URL(this.template.replace('{repo}', 'owner/repo'))
    this.protocol = probe.protocol
    // The relay token is only for the relay; never send it to GitHub itself.
    if (config.relayTokenFile !== undefined && /(^|\.)github\.com$/i.test(probe.hostname)) throw invalid()
    if (config.proxy !== undefined) validProxy(config.proxy)
    this.allowed = [...config.allowedRepos]
    this.fetchTimeoutMs = timeout
    this.gitPath = config.gitPath ?? '/usr/bin/git'
  }

  /** Startup check: private root and readable, private credential files. No network. */
  async verifyConfiguration(): Promise<void> {
    await this.privateRoot()
    await this.secret(this.config.relayTokenFile)
    await this.secret(this.config.githubTokenFile)
  }

  /** Resolves to the local bare repository that contains `baseSha^{commit}`. A
   * caller's signal only stops its wait; a fetch that already started runs to
   * completion or timeout, so a retry can use it. */
  async ensureCommit(repo: string, baseSha: string, signal?: AbortSignal): Promise<string> {
    const canonical = typeof repo === 'string' ? this.allowed.find(entry => entry.toLowerCase() === repo.toLowerCase()) : undefined
    if (!canonical) throw new SourceMirrorError('repository_not_allowed')
    if (typeof baseSha !== 'string' || !SHA.test(baseSha)) throw new SourceMirrorError('invalid_revision')
    if (signal?.aborted) throw new SourceMirrorError('source_fetch_cancelled')
    const key = canonical.toLowerCase(), [owner, name] = key.split('/') as [string, string]
    const path = join(this.root, owner, `${name}.git`)
    await waitFor(this.serial(key, () => this.prepare(canonical, baseSha, path, signal)), signal)
    return path
  }

  private serial(key: string, use: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(use)
    const tail = next.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return next
  }

  private async prepare(repo: string, sha: string, path: string, signal?: AbortSignal): Promise<void> {
    const started = Date.now()
    try {
      await this.repository(path)
      if (await this.recorded(path, sha)) { this.emit(repo, sha, 'hit', started); return }
      // A waiter that left before its turn does not start a download.
      if (signal?.aborted) throw new SourceMirrorError('source_fetch_cancelled')
      await this.removeStaleLocks(path)
      const remote = new URL(this.template.replace('{repo}', repo)).href
      const settings: Array<[string, string]> = []
      if (this.protocol !== 'file:') {
        const relay = await this.secret(this.config.relayTokenFile), github = await this.secret(this.config.githubTokenFile)
        if (relay) settings.push([`http.${remote}.extraHeader`, `x-friday-relay-token: ${relay}`])
        if (github) settings.push([`http.${remote}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${github}`).toString('base64')}`])
        if (this.config.proxy) settings.push([`http.${remote}.proxy`, this.config.proxy])
      }
      const fetched = await this.git(path, ['fetch', '--depth=1', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
        '--quiet', '--', remote, `${sha}:${REF_PREFIX}${sha}`], this.fetchTimeoutMs, settings)
      if (fetched.timedOut) throw new SourceMirrorError('source_fetch_timeout')
      if (fetched.code !== 0) throw new SourceMirrorError('source_fetch_failed')
      if (!await this.recorded(path, sha)) throw new SourceMirrorError('source_revision_unavailable')
      this.emit(repo, sha, 'fetched', started)
    } catch (error) {
      const code = error instanceof SourceMirrorError ? error.code : 'source_mirror_unavailable'
      this.emit(repo, sha, 'failed', started, code)
      throw new SourceMirrorError(code)
    }
  }

  /** The ref is written only after Git has stored the pack and the shallow boundary. */
  private async recorded(path: string, sha: string): Promise<boolean> {
    const result = await this.git(path, ['rev-parse', '--verify', '--quiet', `${REF_PREFIX}${sha}^{commit}`], LOCAL_TIMEOUT)
    if (result.timedOut || result.code === null || result.code > 1) throw new SourceMirrorError('source_mirror_unavailable')
    return result.code === 0 && result.stdout === sha
  }

  private async repository(path: string): Promise<void> {
    await this.privateRoot()
    for (const directory of [join(path, '..'), path]) {
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await privateDirectory(directory)
    }
    if (await exists(join(path, 'HEAD'))) return
    const created = await this.git(undefined, ['init', '--bare', '--quiet', '--template=', path], LOCAL_TIMEOUT)
    if (created.code !== 0 || created.timedOut) throw new SourceMirrorError('source_mirror_unavailable')
  }

  private async privateRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await privateDirectory(this.root)
  }

  /** Only this process writes the mirror and it holds the repository's turn, so
   * a lock or temporary pack here was left by a killed fetch. */
  private async removeStaleLocks(path: string): Promise<void> {
    const targets = ['shallow.lock', 'packed-refs.lock', 'config.lock', 'HEAD.lock'].map(name => join(path, name))
    for (const [directory, stale] of [[join(path, ...REF_PREFIX.split('/').filter(Boolean)), (name: string) => name.endsWith('.lock')],
      [join(path, 'objects', 'pack'), (name: string) => name.startsWith('tmp_')]] as const) {
      let names: string[] = []
      try { names = await readdir(directory) } catch { /* absent before the first fetch */ }
      for (const name of names) if (stale(name)) targets.push(join(directory, name))
    }
    await Promise.all(targets.map(target => rm(target, { force: true })))
  }

  private async secret(file: string | undefined): Promise<string | undefined> {
    if (file === undefined) return undefined
    try {
      const info = await lstat(file)
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('credential_file')
      const value = (await readFile(file, 'utf8')).trim()
      if (!SECRET.test(value)) throw new Error('credential_value')
      return value
    } catch { throw new SourceMirrorError('source_credential_unavailable') }
  }

  private git(gitDir: string | undefined, args: string[], timeoutMs: number, settings: Array<[string, string]> = []): Promise<GitResult> {
    const config: Array<[string, string]> = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['credential.helper', ''],
      ['http.followRedirects', 'false'], ['protocol.allow', 'never'], [`protocol.${this.protocol.slice(0, -1)}.allow`, 'always'],
      ['protocol.version', '2'], ['gc.auto', '0'], ['maintenance.auto', 'false'], ['fetch.writeCommitGraph', 'false'],
      ['fetch.recurseSubmodules', 'false'], ['submodule.recurse', 'false'], ...settings]
    // Values travel in the environment of this user's own Git processes; argv
    // (visible to other accounts through the process table) carries none.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.root, LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: String(config.length) }
    config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value })
    return runGit(this.gitPath, gitDir ? [`--git-dir=${gitDir}`, ...args] : args, env, timeoutMs)
  }

  private emit(repo: string, baseSha: string, outcome: SourceMirrorEvent['outcome'], started: number, code?: SourceMirrorErrorCode) {
    try { this.config.log?.({ event: 'source_mirror', repo, baseSha, outcome, ...(code ? { code } : {}), durationMs: Date.now() - started }) }
    catch { /* A log sink never changes the source result. */ }
  }
}

function remoteTemplate(raw: unknown, protocols: readonly string[]): string {
  if (typeof raw !== 'string' || !raw || /[\0-\x20\x7f]/.test(raw)) throw invalid()
  const template = raw.includes('{repo}') ? raw : `${raw.replace(/\/+$/, '')}/{repo}.git`
  if (template.split('{repo}').length !== 2) throw invalid()
  let probe: URL
  try { probe = new URL(template.replace('{repo}', 'owner/repo')) } catch { throw invalid() }
  if (!protocols.includes(probe.protocol) || probe.username || probe.password || probe.search || probe.hash ||
    probe.protocol !== 'file:' && !probe.hostname || !probe.pathname.endsWith('/owner/repo.git')) throw invalid()
  return template
}

function validProxy(raw: unknown): void {
  let proxy: URL
  try { proxy = new URL(String(raw)) } catch { throw invalid() }
  // A user name without a password makes Git prompt, which fails without a terminal.
  if (typeof raw !== 'string' || /[\0-\x20\x7f]/.test(raw) || !['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname ||
    proxy.pathname !== '/' || proxy.search || proxy.hash || proxy.username && !proxy.password) throw invalid()
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || await realpath(path) !== path) {
    throw new SourceMirrorError('source_mirror_not_private')
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function waitFor(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation
  return new Promise<void>((resolveWait, rejectWait) => {
    const aborted = () => rejectWait(new SourceMirrorError('source_fetch_cancelled'))
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(() => { signal.removeEventListener('abort', aborted); resolveWait() },
      error => { signal.removeEventListener('abort', aborted); rejectWait(error) })
  })
}

/** No shell and no inherited environment. stderr is drained and discarded: Git
 * prints remote URLs there. A timeout sends SIGTERM first so Git can remove its
 * lock files, then SIGKILL to the whole process group. */
function runGit(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<GitResult> {
  return new Promise(resolveResult => {
    let settled = false, timedOut = false, stdout = '', kill: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true; clearTimeout(timer); if (kill) clearTimeout(kill)
      resolveResult({ code, stdout: stdout.trim(), timedOut })
    }
    const child = spawn(file, args, { cwd: '/', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const signalGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, name) } catch { try { child.kill(name) } catch { /* already exited */ } }
    }
    const timer = setTimeout(() => {
      timedOut = true; signalGroup('SIGTERM')
      kill = setTimeout(() => signalGroup('SIGKILL'), TERMINATE_GRACE); kill.unref()
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString('utf8') })
    child.stderr.resume()
    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
  })
}
