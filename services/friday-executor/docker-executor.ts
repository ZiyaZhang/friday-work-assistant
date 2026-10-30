import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { JobExecutor, JobResult } from '../../cloudflare/friday-executor/src/job-controller.js'
import { validateJobInput, type JobInput } from '../../cloudflare/friday-executor/src/job-protocol.js'
import { SOURCE_MIRROR_ERROR_CODES } from './source-mirror.js'
import { OutputCaptureError, captureRepositoryPatch, storeOutputArtifact } from './output-capture.js'

/** Provider-side source cache. The returned path is a local repository that
 * contains `baseSha^{commit}`; its credentials never reach the job or container. */
export interface SourceMirrorProvider {
  ensureCommit(repo: string, baseSha: string, signal?: AbortSignal): Promise<string>
}
export interface DockerResourceLimits { cpus: string; memory: string; pidsLimit: number }
export interface DockerExecutorConfig {
  /** Trusted, preinstalled <lowercase owner>/<repo>/<baseSha>.bundle files. A present bundle is used first. */
  bundleRoot: string
  /** Private local directory owned by the rootless daemon user. */
  workRoot: string
  allowedRepos: readonly string[]
  /** An administrator-selected immutable image; never part of a job input. */
  image: string
  /** Used only when no bundle exists for the base commit. */
  sourceMirror?: SourceMirrorProvider
  /** Private directory for protocol 2 output artifacts. Without it, capture jobs are refused. */
  artifactRoot?: string
  /** Container limits; defaults 1 CPU, 1g memory (no swap), 256 processes. */
  cpus?: string
  memory?: string
  pidsLimit?: number
  dockerHost?: string
  dockerPath?: string
  gitPath?: string
}
type ProcessResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; interrupted: boolean }
type BytesResult = { code: number | null; stdout: Buffer; exceeded: boolean; interrupted: boolean }
type Container = { id: string; running: boolean; status: string; exitCode: number }
const LIMIT = 64 * 1024, HOST_TIMEOUT = 30_000, SHA = /^[a-f0-9]{40}$/, CONTAINER_ID = /^[a-f0-9]{64}$/
const LABEL = 'com.friday.executor.job'
const failure = (code: string) => new Error(code)
/** Fixed diagnosis codes that may appear in a setup_failed result; never raw error text. */
const SETUP_CODES: ReadonlySet<string> = new Set(['source_bundle_unavailable', 'source_revision_mismatch',
  'rootless_engine_unavailable', 'executor_work_root_not_private', ...SOURCE_MIRROR_ERROR_CODES])

/** Validates administrator-selected limits (not job input). Memory is also the swap limit. */
export function dockerResourceLimits(input: { cpus?: string; memory?: string; pidsLimit?: number | string } = {}): DockerResourceLimits {
  const cpus = input.cpus ?? '1', memory = input.memory ?? '1g', rawPids = input.pidsLimit ?? 256
  const pidsLimit = typeof rawPids === 'string' ? (/^[1-9][0-9]{0,6}$/.test(rawPids) ? Number(rawPids) : Number.NaN) : rawPids
  const size = typeof memory === 'string' ? /^([1-9][0-9]{0,6})([mg])$/.exec(memory) : null
  const mebibytes = size ? Number(size[1]) * (size[2] === 'g' ? 1024 : 1) : 0
  if (typeof cpus !== 'string' || !/^(?:[1-9][0-9]{0,2}(?:\.[0-9]{1,2})?|0\.(?:[1-9][0-9]?|0[1-9]))$/.test(cpus) ||
    mebibytes < 64 || mebibytes > 1024 * 1024 || !Number.isSafeInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 65536) {
    throw failure('invalid_docker_executor_configuration')
  }
  return { cpus, memory, pidsLimit }
}

/** One provider job, never a Work or an authorization store. Only a worktree
 * crosses the container boundary. Git metadata and Docker credentials stay in
 * the private host directory; a source-changing command cannot import or push. */
export class DockerJobExecutor implements JobExecutor {
  private readonly config: DockerExecutorConfig
  private readonly resources: DockerResourceLimits
  private readonly name: string
  private readonly directory: string
  private readonly tree: string
  private readonly metadata: string
  private readonly pendingCreate: string
  private readonly hostAbort = new AbortController()
  private closing = false
  private used = false
  private creating?: Promise<ProcessResult>
  private attaching?: Promise<ProcessResult>
  private cleanup?: Promise<void>

  constructor(private readonly jobId: string, config: DockerExecutorConfig) {
    if (!/^[a-z0-9][a-z0-9-]{15,79}$/.test(jobId) ||
      !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(config.image) ||
      !Array.isArray(config.allowedRepos) || config.allowedRepos.length === 0 ||
      config.allowedRepos.some(repo => typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) ||
      [config.bundleRoot, config.workRoot, config.dockerPath ?? '/usr/bin/docker', config.gitPath ?? '/usr/bin/git',
        ...(config.artifactRoot === undefined ? [] : [config.artifactRoot])]
        .some(path => typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n,]/.test(path)) ||
      config.sourceMirror !== undefined && typeof config.sourceMirror?.ensureCommit !== 'function') throw failure('invalid_docker_executor_configuration')
    const dockerHost = config.dockerHost ?? `unix:///run/user/${process.getuid?.() ?? -1}/docker.sock`
    if (!/^unix:\/\/\/[^\0\r\n?#]+$/.test(dockerHost)) throw failure('invalid_docker_executor_configuration')
    this.resources = dockerResourceLimits(config)
    this.config = { ...config, dockerHost, allowedRepos: [...config.allowedRepos] }
    this.name = `friday-${createHash('sha256').update(jobId).digest('hex').slice(0, 48)}`
    this.directory = join(resolve(config.workRoot), this.name)
    this.tree = join(this.directory, 'tree'); this.metadata = join(this.directory, 'git')
    this.pendingCreate = join(this.directory, 'create.pending')
  }

  async run(input: JobInput, checkCurrent: () => void): Promise<JobResult> {
    if (this.used || this.closing) throw failure('executor_job_already_started_or_stopped')
    this.used = true
    const check = () => { if (this.closing) throw failure('executor_stopped'); checkCurrent() }
    let job: JobInput, beforeTree: string | null = null
    const result = (status: JobResult['status'], phase: JobResult['phase'], output = { stdout: '', stderr: '', truncated: false },
      afterTree: string | null = null, exitCode: number | null = null): JobResult => ({ status, phase, beforeTree, afterTree,
        exitCode, output, runtime: 'rootless-docker' })
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value }
    try {
      job = validateJobInput(input, this.config.allowedRepos, { capture: this.config.artifactRoot !== undefined })
      const bundle = join(resolve(this.config.bundleRoot), job.repo.toLowerCase(), `${job.baseSha}.bundle`)
      await checked(() => this.prepareDirectory())
      // A present bundle keeps precedence; only an absent one selects the mirror.
      const useBundle = await checked(() => trustedBundle(bundle))
      if (!useBundle && !this.config.sourceMirror) throw failure('source_bundle_unavailable')
      const engine = await checked(() => this.docker(['info', '--format', '{{json .SecurityOptions}}']))
      if (engine.code !== 0 || engine.interrupted || engine.truncated || !rootless(engine.stdout)) throw failure('rootless_engine_unavailable')
      await checked(() => this.git(['init', '--bare', '--template=', this.metadata], false))
      // Highest-precedence attributes disable conversions as well as filters.
      // No repository/global config, hooks, helpers or submodules are executed.
      await checked(() => mkdir(join(this.metadata, 'info'), { recursive: true, mode: 0o700 }))
      await checked(() => writeFile(join(this.metadata, 'info', 'attributes'), '* -text -eol -ident -filter -working-tree-encoding\n', { mode: 0o600 }))
      if (useBundle) await checked(() => this.git(['fetch', '--no-tags', '--no-recurse-submodules', '--', bundle, job.baseSha]))
      else {
        const mirror = await checked(() => this.config.sourceMirror!.ensureCommit(job.repo, job.baseSha, this.hostAbort.signal))
        if (typeof mirror !== 'string' || !isAbsolute(mirror) || /[\0\r\n]/.test(mirror)) throw failure('source_mirror_unavailable')
        // Local transport from the provider's mirror: the job repository gets
        // objects only, never the mirror's remote, proxy or credentials.
        await checked(() => this.git(['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', mirror, job.baseSha]))
      }
      const commit = await checked(() => this.git(['rev-parse', '--verify', `${job.baseSha}^{commit}`]))
      if (commit !== job.baseSha) throw failure('source_revision_mismatch')
      await checked(() => this.git(['read-tree', job.baseSha]))
      await checked(() => this.git(['checkout-index', '--all', '--force', '--index']))
      if (job.patch) {
        const patch = join(this.directory, 'input.patch')
        await checked(() => writeFile(patch, job.patch, { mode: 0o600, flag: 'wx' }))
        await checked(() => this.git(['apply', '--index', '--binary', '--whitespace=nowarn', '--', patch]))
      }
      const prepared = await checked(() => this.git(['write-tree']))
      beforeTree = await checked(() => this.snapshot(prepared))
      if (beforeTree !== job.inputTree) return result('input_mismatch', 'prepare')
    } catch (error) {
      check()
      const code = error instanceof Error && SETUP_CODES.has(error.message) ? ` (${error.message})` : ''
      return result('setup_failed', 'prepare', { stdout: '', stderr: `Trusted local source or rootless Docker preparation failed${code}.`, truncated: false })
    }

    check()
    // Publish the promise synchronously before yielding; destroy cannot race
    // past an untracked create. A killed CLI leaves an uncertain-create marker.
    this.creating = (async () => {
      let submitted = false
      try {
        await writeFile(this.pendingCreate, this.jobId, { flag: 'wx', mode: 0o600 })
        check(); submitted = true
        const created = await this.docker(['create', '--name', this.name, '--label', `${LABEL}=${this.jobId}`, '--pull', 'never',
          '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '0:0',
          '--cpus', this.resources.cpus, '--memory', this.resources.memory, '--memory-swap', this.resources.memory,
          '--pids-limit', String(this.resources.pidsLimit), '--restart', 'no',
          '--read-only', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '--mount', `type=bind,src=${this.tree},dst=/workspace/repo`, '--workdir', '/workspace/repo',
          '--env', 'HOME=/tmp', '--env', 'CI=true', '--env', 'LANG=C.UTF-8', '--entrypoint', '/bin/sh',
          this.config.image, '-c', job.command])
        if (created.code === 0 && !created.interrupted && !created.truncated && CONTAINER_ID.test(created.stdout.trim())) {
          await rm(this.pendingCreate, { force: true })
        }
        return created
      } finally {
        if (!submitted) await rm(this.pendingCreate, { force: true })
      }
    })()
    const created = await this.creating
    check()
    if (created.code !== 0 || created.truncated || created.interrupted || !CONTAINER_ID.test(created.stdout.trim())) {
      throw failure('docker_create_unconfirmed')
    }
    const containerId = created.stdout.trim()
    this.attaching = this.docker(['start', '--attach', containerId], job.timeoutMs)
    const execution = await this.attaching
    check()
    if (execution.interrupted) throw failure('docker_command_transport_interrupted')
    const container = await checked(() => this.findContainer())
    if (!container || container.id !== containerId || container.running || !['exited', 'dead'].includes(container.status)) {
      throw failure('docker_command_exit_unconfirmed')
    }
    // Remove the complete container before hashing files; no detached child can
    // race a host verification. This is not just an attach-process exit check.
    await checked(() => this.removeContainer())
    const output = { stdout: execution.stdout, stderr: execution.stderr, truncated: execution.truncated }
    let afterTree: string
    try { afterTree = await checked(() => this.snapshot(beforeTree!)) }
    catch {
      check()
      return { ...result('source_changed', 'verify', output, null, container.exitCode), ...(job.capture ? { outputError: 'worktree_unverifiable' } : {}) }
    }
    const final = result(afterTree !== beforeTree ? 'source_changed' : output.truncated ? 'output_limit' : container.exitCode === 0 ? 'passed' : 'failed',
      'command', output, afterTree, container.exitCode)
    // Protocol 2: a successful command's changes may leave as one verified,
    // immutable patch. Status stays source_changed; it is never a validation.
    if (!job.capture || afterTree === beforeTree) return final
    if (container.exitCode !== 0) return { ...final, outputError: 'command_failed' }
    try {
      const captured = await checked(() => captureRepositoryPatch({ bytes: (args, options) => this.gitBytes(args, options) },
        { workTree: this.tree, scratch: join(this.directory, 'capture'), capture: job.capture!, beforeTree: beforeTree!, afterTree }))
      const artifact = await checked(() => storeOutputArtifact(this.config.artifactRoot!, this.jobId,
        { ...captured, beforeTree: beforeTree!, afterTree }))
      return { ...final, outputArtifact: artifact }
    } catch (error) {
      check()
      return { ...final, outputError: error instanceof OutputCaptureError ? error.code : 'output_capture_failed' }
    }
  }

  /** May be called on a freshly constructed instance after a process restart.
   * A failed Docker query/removal is not evidence of absence. Keep pending. */
  destroy(): Promise<void> {
    this.closing = true; this.hostAbort.abort()
    if (this.cleanup) return this.cleanup
    const pending = (async () => {
      await this.creating?.catch(() => {})
      await this.removeContainer()
      await this.attaching
      await this.removeContainer()
    })()
    this.cleanup = pending
    void pending.catch(() => { if (this.cleanup === pending) this.cleanup = undefined })
    return pending
  }

  private async prepareDirectory() {
    const workRoot = resolve(this.config.workRoot)
    await mkdir(workRoot, { recursive: true, mode: 0o700 })
    const info = await lstat(workRoot)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || await realpath(workRoot) !== workRoot) {
      throw failure('executor_work_root_not_private')
    }
    await mkdir(this.directory, { mode: 0o700 }) // Existing work is never rerun.
    await mkdir(this.tree, { mode: 0o700 }); await mkdir(join(this.directory, 'home'), { mode: 0o700 })
    await mkdir(join(this.directory, 'docker-config'), { mode: 0o700 })
  }

  private environment(): NodeJS.ProcessEnv {
    return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(this.directory, 'home'), LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', DOCKER_HOST: this.config.dockerHost,
      DOCKER_CONFIG: join(this.directory, 'docker-config') }
  }

  private async git(args: string[], prepared = true, index?: string): Promise<string> {
    const common = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
      '-c', 'core.autocrlf=false', '-c', 'core.bare=false', '-c', 'core.filemode=true', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always']
    const value = await processRun(this.config.gitPath ?? '/usr/bin/git', [...common,
      ...(prepared ? [`--git-dir=${this.metadata}`, `--work-tree=${this.tree}`] : []), ...args],
    { ...this.environment(), ...(index ? { GIT_INDEX_FILE: index } : {}) }, prepared ? this.tree : this.directory, HOST_TIMEOUT, this.hostAbort.signal)
    if (value.code !== 0 || value.truncated || value.interrupted) throw failure('trusted_git_operation_failed')
    return value.stdout.trim()
  }

  /** Raw bytes from the job's private Git metadata. Exceeding `limit` is a
   * rejected output, never a truncated one. */
  private async gitBytes(args: string[], options: { limit: number; index?: string; workTree?: string }): Promise<Buffer> {
    const common = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
      '-c', 'core.autocrlf=false', '-c', 'core.bare=false', '-c', 'core.filemode=true', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'core.quotePath=true']
    const value = await processBytes(this.config.gitPath ?? '/usr/bin/git', [...common, `--git-dir=${this.metadata}`,
      `--work-tree=${options.workTree ?? this.tree}`, ...args], { ...this.environment(), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
    this.directory, HOST_TIMEOUT, options.limit, this.hostAbort.signal)
    if (value.exceeded) throw new OutputCaptureError('output_too_large')
    if (value.code !== 0 || value.interrupted) throw failure('trusted_git_operation_failed')
    return value.stdout
  }

  private async snapshot(seed: string): Promise<string> {
    if (!SHA.test(seed)) throw failure('invalid_tree')
    await safeTree(this.tree, this.hostAbort.signal)
    const index = join(this.directory, 'snapshot.index')
    await rm(index, { force: true })
    await this.git(['read-tree', seed], true, index)
    await this.git(['add', '--all', '--', '.'], true, index)
    const tree = await this.git(['write-tree'], true, index)
    if (!SHA.test(tree)) throw failure('invalid_tree')
    return tree
  }

  private docker(args: string[], timeout = HOST_TIMEOUT): Promise<ProcessResult> {
    return processRun(this.config.dockerPath ?? '/usr/bin/docker', args, this.environment(), '/', timeout)
  }

  private async findContainer(): Promise<Container | undefined> {
    const listed = await this.docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${this.name}$`, '--format', '{{.ID}}'])
    if (listed.code !== 0 || listed.interrupted || listed.truncated) throw failure('docker_inspection_unconfirmed')
    const id = listed.stdout.trim()
    if (!id) return undefined
    if (!CONTAINER_ID.test(id)) throw failure('docker_container_identity_mismatch')
    const inspected = await this.docker(['container', 'inspect', '--format', '{{json .}}', id])
    if (inspected.code !== 0 || inspected.interrupted || inspected.truncated) throw failure('docker_inspection_unconfirmed')
    let value: any
    try { value = JSON.parse(inspected.stdout) } catch { throw failure('docker_inspection_unconfirmed') }
    if (value?.Id !== id || value.Name !== `/${this.name}` || value.Config?.Labels?.[LABEL] !== this.jobId ||
      typeof value.State?.Running !== 'boolean' || typeof value.State.Status !== 'string' || !Number.isInteger(value.State.ExitCode)) {
      throw failure('docker_container_identity_mismatch')
    }
    return { id, running: value.State.Running, status: value.State.Status, exitCode: value.State.ExitCode }
  }

  private async removeContainer() {
    const container = await this.findContainer()
    if (container) {
      const removed = await this.docker(['container', 'rm', '--force', '--volumes', container.id])
      if (removed.code !== 0 || removed.interrupted || removed.truncated) throw failure('docker_removal_unconfirmed')
      if (await this.findContainer()) throw failure('docker_removal_unconfirmed')
      await rm(this.pendingCreate, { force: true })
    } else if (await fileExists(this.pendingCreate)) {
      // A create whose acknowledgement was lost may still reach the daemon.
      throw failure('docker_create_unconfirmed')
    }
  }
}

/** true: a regular file at its canonical path; false: absent. Any other state fails closed. */
async function trustedBundle(path: string): Promise<boolean> {
  let info
  try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  if (!info.isFile() || await realpath(path) !== path) throw failure('source_bundle_unavailable')
  return true
}
function rootless(output: string): boolean {
  try { const value: unknown = JSON.parse(output); return Array.isArray(value) && value.includes('name=rootless') } catch { return false }
}
async function fileExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function safeTree(path: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + HOST_TIMEOUT
  let entries = 0
  const walk = async (directory: string): Promise<void> => {
    if (signal.aborted || Date.now() >= deadline) throw failure('worktree_verification_interrupted')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 200_000) throw failure('worktree_verification_limit')
      if (entry.name.toLowerCase() === '.git') throw failure('untrusted_git_metadata_in_worktree')
      if (entry.isDirectory()) await walk(join(directory, entry.name))
      else if (!entry.isFile() && !entry.isSymbolicLink()) throw failure('unsupported_worktree_entry')
    }
  }
  await walk(path)
}

/** Like processRun, but keeps raw stdout bytes and stops the process once more
 * than `limit` bytes arrive. stderr is drained and discarded. */
function processBytes(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number, limit: number,
  signal?: AbortSignal): Promise<BytesResult> {
  return new Promise(resolveResult => {
    if (signal?.aborted) { resolveResult({ code: null, stdout: Buffer.alloc(0), exceeded: false, interrupted: true }); return }
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0, exceeded = false, interrupted = false
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } } }
    const terminate = () => { interrupted = true; kill() }
    const timer = setTimeout(terminate, timeoutMs); timer.unref()
    signal?.addEventListener('abort', terminate, { once: true })
    child.stdout.on('data', data => {
      if (exceeded) return
      const bytes = Buffer.from(data)
      size += bytes.length
      if (size > limit) { exceeded = true; chunks.length = 0; kill(); return }
      chunks.push(bytes)
    })
    child.stderr.resume()
    child.on('error', () => { interrupted = true })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', terminate)
      resolveResult({ code, stdout: Buffer.concat(chunks), exceeded, interrupted })
    })
  })
}

/** No shell and no inherited environment. Retain bounded bytes while draining
 * both streams; process close is awaited after cancellation/timeout. */
function processRun(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number,
  signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise(resolveResult => {
    if (signal?.aborted) { resolveResult({ code: null, stdout: '', stderr: '', truncated: false, interrupted: true }); return }
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }
    let truncated = false, interrupted = false
    const terminate = () => {
      interrupted = true
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const timer = setTimeout(terminate, timeoutMs); timer.unref()
    signal?.addEventListener('abort', terminate, { once: true })
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', data => {
      const bytes = Buffer.from(data), left = Math.max(0, LIMIT - sizes[stream])
      if (bytes.length > left) truncated = true
      if (left) { const kept = bytes.subarray(0, left); chunks[stream].push(kept); sizes[stream] += kept.length }
    })
    child.on('error', () => { interrupted = true })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', terminate)
      const decode = (stream: 'stdout' | 'stderr') => {
        const text = new TextDecoder().decode(Buffer.concat(chunks[stream]), { stream: true })
        const encoded = Buffer.from(text)
        if (encoded.length > LIMIT) truncated = true
        return new TextDecoder().decode(encoded.subarray(0, LIMIT), { stream: true })
      }
      const stdout = decode('stdout'), stderr = decode('stderr')
      resolveResult({ code, stdout, stderr, truncated, interrupted })
    })
  })
}
