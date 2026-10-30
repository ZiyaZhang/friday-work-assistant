/** 独立 checkout + 网关 DB 绑定；可信 gitdir 发布审批过的 tree，未知 PR 只核对、不重发。 */
import type { PrReplyItem } from '../core/pr-reply-judge.js'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialQueue } from '../core/queue.js'
import type { GitHubIdentity } from './identity.js'
import type { Logger } from '../log.js'
import { GitHubTransport } from './transport.js'
import { RepositoryExecutionImportPending, pendingExecutionImport } from './executions.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS github_change_preparations (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  session_key TEXT NOT NULL,
  requester_open_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','prepared','retryable','cancelled','interrupted')),
  result TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS github_changes (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  requester_open_id TEXT NOT NULL,
  origin_work_key TEXT,
  cwd TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  git_dir TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  snapshot TEXT,
  publish_intent TEXT,
  commit_id TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS github_change_updates (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES github_changes(id),
  parent_commit TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  intent TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(change_id, parent_commit, snapshot, intent)
);
CREATE UNIQUE INDEX IF NOT EXISTS github_change_update_pending
  ON github_change_updates(change_id) WHERE state != 'confirmed';`

export interface ChangeMarker { repo: string; branch: string; base: string; createdAt: number }
export class ChangeAccessError extends Error { readonly status = 403 }
export class ChangeSnapshotError extends Error {
  constructor() { super('修改副本已变化，请重新读取当前文件后再验证') }
}
export interface ChangeIdentity {
  cwd: string; sessionKey?: string; requesterOpenId?: string
  /** Host-resolved original Work. Omission is reserved for historical internal callers. */
  workKey?: string
  /** 仅网关可提供；在异步 Git / token 操作之后、对外写入之前重验当前授权。 */
  assertAuthorized?: () => void
  signal?: AbortSignal
}
export interface ChangeFileLease {
  id: string; repo: string; dir: string
  assertCurrent(): void
  snapshot(): Promise<string>
  /** Trusted Git path inventory; not content or publication evidence. */
  pathInventory(path: string): Promise<{ paths: string[]; complete: boolean }>
  /** Output import: rebuilds baseTree plus an exact binary patch in a private
   * index of the trusted Git directory. No worker file is read or written. */
  stageOutput(baseTree: string, patch: Buffer): Promise<{ tree: string; entries: StagedOutputEntry[] }>
  /** Output import: blob bytes from the trusted Git directory (UTF-8 text only; other bytes do not round-trip). */
  readBlob(blob: string): Promise<Buffer>
}
/** One `git diff-tree --raw` entry between the staged base and result trees. */
export interface StagedOutputEntry { path: string; status: string; srcMode: string; dstMode: string; srcBlob: string; dstBlob: string }
export interface ChangePreparationResult { id: string; dir: string; branch: string; base: string; head: string; history?: 'base_snapshot'; operationId?: string; replayed?: boolean }
export interface ChangePreparation {
  id: string; operationKey: string; repo: string; attemptKey: string
  state: 'preparing' | 'prepared' | 'retryable' | 'cancelled' | 'interrupted'
  result: ChangePreparationResult | null; errorCode: string | null
}
export class ChangePreparationError extends Error {
  constructor(readonly preparation: ChangePreparation) {
    super(`修改副本准备${preparation.state === 'preparing' ? '仍在进行' : '尚未完成'}（${preparation.state}${preparation.errorCode ? ` / ${preparation.errorCode}` : ''}）；请查询这次准备记录，不要重复新建。`)
    this.name = 'ChangePreparationError'
  }
}
export class ChangeGitError extends Error {
  constructor(readonly code: string, readonly operation: string, readonly exitCode: number | null) {
    super(`Git ${operation} 未完成（${code}）`); this.name = 'ChangeGitError'
  }
}
interface ChangeBinding extends ChangeMarker {
  id: string; sessionKey: string; requesterOpenId: string; cwd: string; dir: string
  originWorkKey: string | null
  baseCommit: string; remoteUrl: string; gitDir: string; state: string
  snapshot: string | null; publishIntent: string | null; commitId: string | null
  prNumber: number | null; prUrl: string | null; result: ChangeResult | null
}
export interface ChangeInspection extends ChangeMarker {
  id: string; dir: string; head: string; baseCommit: string; snapshot: string; files: string[]; stat: string
}
export interface ChangeUpdateInspection extends ChangeInspection {
  prNumber: number; prUrl: string; expectedHead: string; noChanges: boolean
}
export interface ChangeListEntry {
  id: string; dir: string; repo: string; base: string; branch: string; state: string
  prNumber: number | null; prUrl: string | null; commitId: string | null
  /** Historical metadata may be shown; only current is operational for a Work-aware caller. */
  workAccess?: 'current' | 'other_work' | 'legacy_unbound'
}
interface ChangeUpdate {
  id: string; parentCommit: string; snapshot: string; intent: string; commitId: string
  state: string; result: ChangeResult | null
}
/** PR 走到哪一段了。`phase` 是给人看的那一句话的依据。 */
export interface PrLifecycle {
  repo: string
  number: number
  url: string
  draft: boolean
  merged: boolean
  closed: boolean
  phase: 'draft' | 'ready' | 'merged' | 'closed'
}

export interface ChangeResult {
  url: string; number: number; branch: string; base: string; repo: string; files: string[]; head: string
  phase: 'pushed' | 'confirmed'; replayed?: boolean
}
/** Trusted publication facts; an in-flight/unknown update has no settled head. */
export interface ConfirmedPublication {
  changeId: string; repo: string; number: number; url: string; head: string; snapshot: string
  workKey: string; sessionKey: string; requesterOpenId: string
}
export interface ChangeManagerOptions {
  db: DatabaseSync
  cacheDir: string
  github: GitHubIdentity
  log: Logger
  proxyUrl?: string
  transport?: GitHubTransport
  /** 仅测试以 file:// bare 仓库替代 GitHub。 */
  remoteUrlFor?: (repo: string) => string
  /** file:// 测试配合假 HTTP 验证 PR 恢复；默认只有 HTTPS 远端创建 PR。 */
  createPullRequests?: boolean
  author?: { name: string; email: string }
  now?: () => number
}
export const MARKER_FILE = '.friday-change.json'
const UNKNOWN_PR = 'PR 发布结果未知，须核对远端；不会自动重复创建 PR'
const UNKNOWN_UPDATE = 'PR 追加提交结果未知，须核对远端；不会自动重复推送'
const UPDATE_SYNC_PENDING = '推送已完成，尚未确认 PR 同步；稍后核对原更新，不会重复推送'
export function slugify(hint: string): string {
  return hint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'change'
}

/** Schema-only entry point shared by startup and protected-copy migration. */
export function ensureGitHubChangeSchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
  if (!db.prepare('PRAGMA table_info(github_changes)').all().some(column => column.name === 'origin_work_key')) {
    // An old row has no proof of its original Work. Never assign it to the next caller.
    db.exec('ALTER TABLE github_changes ADD COLUMN origin_work_key TEXT')
  }
}

export class ChangeManager {
  private readonly now: () => number
  private readonly queue = new SerialQueue()
  private readonly preparations = new Map<string, Promise<ChangePreparationResult>>()
  private readonly transport: GitHubTransport
  constructor(private readonly opts: ChangeManagerOptions) {
    this.now = opts.now ?? (() => Date.now())
    this.transport = opts.transport ?? opts.github.transport ?? new GitHubTransport()
    ensureGitHubChangeSchema(opts.db)
  }
  private remoteUrl(repo: string): string {
    return this.opts.remoteUrlFor ? this.opts.remoteUrlFor(repo) : this.transport.gitRemote(repo)
  }
  private gitTarget(repo: string, registeredRemote = this.remoteUrl(repo)) {
    if (this.opts.remoteUrlFor) {
      if (registeredRemote !== this.opts.remoteUrlFor(repo)) throw new Error('测试远端与登记不符')
      return { url: registeredRemote, headers: {} as Record<string,string> }
    }
    return this.transport.gitRequest(repo, registeredRemote)
  }
  private cachePath(repo: string): string { return resolve(this.opts.cacheDir, `${repo.replace('/', '__')}.git`) }

  /** 凭证只用于可信 gitdir 的 fetch/push，不进入 worker 的任何 git 操作。 */
  private async authEnv(repo: string, signal?: AbortSignal, registeredRemote = this.remoteUrl(repo)): Promise<Record<string, string>> {
    signal?.throwIfAborted()
    const env: Record<string, string> = {}
    const target = this.gitTarget(repo, registeredRemote)
    if (target.url.startsWith('https://')) {
      const token = await this.opts.github.token(repo.split('/')[0], signal)
      signal?.throwIfAborted()
      env.FRIDAY_GIT_AUTH_HEADER = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
      env.FRIDAY_GIT_AUTH_SCOPE = target.url
      if (target.headers['x-friday-relay-token']) env.FRIDAY_GIT_RELAY_HEADER = `x-friday-relay-token: ${target.headers['x-friday-relay-token']}`
      if (this.opts.proxyUrl) env.FRIDAY_GIT_AUTH_PROXY = this.opts.proxyUrl
    }
    return env
  }
  private async git(args: string[], cwd?: string, env: Record<string, string> = {}, beforeStart?: () => void, signal?: AbortSignal, preserveOutput = false): Promise<string> {
    signal?.throwIfAborted()
    const { FRIDAY_GIT_AUTH_HEADER: header, FRIDAY_GIT_AUTH_PROXY: proxy,
      FRIDAY_GIT_AUTH_SCOPE: scope, FRIDAY_GIT_RELAY_HEADER: relayHeader, ...childEnv } = env
    let authDir: string | undefined
    try {
      const authArgs: string[] = []
      if (header) {
        if (!scope || !scope.startsWith('https://') || /[\r\n]/.test(scope)) throw new Error('Git HTTP 凭据缺少精确目的地作用域')
        // Git 2.25 没有 GIT_CONFIG_COUNT。凭证写入 worker 之外的 0600 临时配置，argv 只有路径。
        mkdirSync(this.opts.cacheDir, { recursive: true, mode: 0o700 })
        authDir = mkdtempSync(join(realpathSync(this.opts.cacheDir), '.auth-'))
        const authFile = join(authDir, 'config')
        writeFileSync(authFile, `[http ${gitConfigValue(scope)}]\n\textraHeader =\n\textraHeader = ${gitConfigValue(header)}\n${relayHeader ? `\textraHeader = ${gitConfigValue(relayHeader)}\n` : ''}${proxy ? `\tproxy = ${gitConfigValue(proxy)}\n` : ''}`, { mode: 0o600 })
        authArgs.push('-c', `include.path=${authFile}`)
      }
      beforeStart?.()
      signal?.throwIfAborted()
      const child = spawn('git', [...authArgs, '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'core.pager=cat', ...args], {
        cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        // 不继承 GIT_DIR、GIT_CONFIG_*、SSH 命令或网关的应用密钥。
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', ...childEnv },
      })
      return await new Promise<string>((resolve, reject) => {
        const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
        let stdout = '', stderr = '', bytes = 0, failure: string | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
        const kill = (kind: NodeJS.Signals) => {
          try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind); else child.kill(kind) } catch { /* already exited */ }
        }
        const stop = (code: string) => {
          if (failure) return
          failure = code; kill('SIGTERM')
          killTimer = setTimeout(() => kill('SIGKILL'), 500); killTimer.unref()
        }
        const aborted = () => stop('cancelled')
        const timer = setTimeout(() => stop('timeout'), 120_000); timer.unref()
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
        child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop('output_limit'); else stdout += stdoutDecoder.write(data) })
        child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop('output_limit'); else stderr += stderrDecoder.write(data) })
        child.on('error', () => { failure ??= 'spawn_failed' })
        child.on('close', code => {
          stdout += stdoutDecoder.end(); stderr += stderrDecoder.end()
          clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', aborted)
          if (!failure && code === 0) { resolve(preserveOutput ? stdout : stdout.trim()); return }
          const classification = failure ?? classifyGitFailure(stderr)
          reject(new ChangeGitError(classification, args.find(arg => !arg.startsWith('-')) ?? 'command', code))
        })
      })
    } finally {
      if (authDir) rmSync(authDir, { recursive: true, force: true })
    }
  }
  private async ensureCache(repo: string, base: string, input: ChangeIdentity): Promise<string> {
    const check = () => { input.signal?.throwIfAborted(); input.assertAuthorized?.(); if (!this.opts.github.repoAllowed(repo)) throw new Error('仓库不再允许读取') }
    let active = false
    const queued = this.queue.run(`cache:${repo}`, async () => {
      active = true
      check()
      const dir = this.cachePath(repo)
      const env = await this.authEnv(repo, input.signal)
      check()
      mkdirSync(this.opts.cacheDir, { recursive: true, mode: 0o700 })
      if (!existsSync(join(dir, 'HEAD'))) await this.git(['init', '--bare', '--quiet', dir], undefined, {}, check, input.signal)
      check()
      // A prepared change needs this base tree, not every branch/tag and the repository's entire history.
      await this.git(['fetch', '--quiet', '--no-tags', '--depth=1', this.gitTarget(repo).url, `+refs/heads/${base}:refs/heads/${base}`], dir, env, check, input.signal)
      check()
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${base}`], dir, {}, check, input.signal)
      check()
      return dir
    })
    // The queued closure checks cancellation before touching tokens, Git or DB. A cancelled waiter
    // settles now and will not become a late clone when an earlier repository operation returns.
    return waitForPreparation(queued, input.signal, () => active)
  }
  async defaultBranch(repo: string, input: ChangeIdentity = { cwd: '' }): Promise<string> {
    input.signal?.throwIfAborted(); input.assertAuthorized?.()
    if (this.remoteUrl(repo).startsWith('https://')) {
      const r = await this.opts.github.api<{ default_branch?: string }>('GET', `/repos/${repo}`, undefined, repo.split('/')[0], input.assertAuthorized, input.signal)
      input.signal?.throwIfAborted(); input.assertAuthorized?.()
      if (r.default_branch) return r.default_branch
    }
    const refs = await this.git(['ls-remote', '--symref', this.gitTarget(repo).url, 'HEAD'], undefined, await this.authEnv(repo,input.signal), input.assertAuthorized, input.signal)
    const branch = refs.match(/^ref: refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1]
    if (!branch) throw new Error('远端没有返回可核验的默认分支')
    return branch
  }
  private identity(input: ChangeIdentity): { sessionKey: string; requesterOpenId: string } {
    if (!input.sessionKey || !input.requesterOpenId) throw new ChangeAccessError('修改副本需要当前会话与发起人身份')
    if (input.workKey !== undefined && (!input.workKey.trim() || input.workKey.length > 200)) throw new ChangeAccessError('修改副本缺少有效的原工作绑定')
    return { sessionKey: input.sessionKey, requesterOpenId: input.requesterOpenId }
  }
  private assertWork(binding: ChangeBinding, input: ChangeIdentity): void {
    // Compatibility is symmetric: only an old NULL row and a legacy internal
    // caller without a Work may match. Missing input can never bypass a binding.
    if (binding.originWorkKey !== (input.workKey ?? null)) {
      throw new ChangeAccessError(binding.originWorkKey === null
        ? '旧修改副本缺少原工作绑定，不能借当前工作继续操作；请先核对原结果'
        : '修改副本不属于当前原工作，请回到创建它的委托继续处理')
    }
  }

  /** Schema-only construction is inert. The startup owner explicitly retires orphaned local preparation attempts. */
  recoverPreparations(): number {
    return Number(this.opts.db.prepare("UPDATE github_change_preparations SET state='interrupted',error_code='host_interrupted',updated_at=? WHERE state='preparing'")
      .run(this.now()).changes)
  }
  /** Host read model for an already recorded operation reference; never expose as an unscoped model lookup. */
  preparationStatus(id: string): ChangePreparation['state'] | undefined {
    return this.opts.db.prepare('SELECT state FROM github_change_preparations WHERE id=?').get(id)?.state as ChangePreparation['state'] | undefined
  }
  listPreparations(input: ChangeIdentity): ChangePreparation[] {
    input.signal?.throwIfAborted(); input.assertAuthorized?.()
    const actor = this.identity(input)
    let cwd = resolve(input.cwd)
    try { cwd = realpathSync(cwd) } catch { /* retain failed records after a workspace was removed */ }
    const rows = this.opts.db.prepare(`SELECT * FROM github_change_preparations
      WHERE session_key=? AND requester_open_id=? AND cwd=? ORDER BY created_at DESC,rowid DESC`)
      .all(actor.sessionKey, actor.requesterOpenId, cwd) as Record<string, unknown>[]
    return rows.map(row => ({ id: String(row.id), operationKey: String(row.operation_key), repo: String(row.repo), attemptKey: String(row.attempt_key),
      state: row.state as ChangePreparation['state'], result: row.result ? JSON.parse(String(row.result)) : null, errorCode: row.error_code as string | null }))
  }
  preparation(input: ChangeIdentity & { operationKey: string }): ChangePreparation | undefined {
    input.signal?.throwIfAborted(); input.assertAuthorized?.()
    const actor = this.identity(input)
    const row = this.opts.db.prepare('SELECT * FROM github_change_preparations WHERE operation_key=?').get(input.operationKey) as Record<string, unknown> | undefined
    if (!row) return undefined
    let cwd = resolve(input.cwd)
    try { cwd = realpathSync(cwd) } catch { /* cancelled before workspace creation */ }
    if (row.session_key !== actor.sessionKey || row.requester_open_id !== actor.requesterOpenId || row.cwd !== cwd) throw new Error('准备记录不属于当前会话与发起人')
    return { id: String(row.id), operationKey: String(row.operation_key), repo: String(row.repo), attemptKey: String(row.attempt_key),
      state: row.state as ChangePreparation['state'], result: row.result ? JSON.parse(String(row.result)) : null, errorCode: row.error_code as string | null }
  }

  /** A query has the same original Work/repository/base binding as admission.
   * Knowing an operation key in the same conversation cannot borrow another Work. */
  preparationForRequest(input: ChangeIdentity & { operationKey: string; repo: string; base?: string }): ChangePreparation | undefined {
    const preparation = this.preparation(input)
    if (!preparation) return undefined
    let cwd = resolve(input.cwd)
    try { cwd = realpathSync(cwd) } catch { /* a failed preparation may not have created its workspace */ }
    const row = this.opts.db.prepare('SELECT signature FROM github_change_preparations WHERE id=?').get(preparation.id)
    if (row?.signature !== this.preparationSignature(input, cwd)) throw new ChangeAccessError('准备记录不属于当前工作、仓库或基线')
    return preparation
  }

  private preparationSignature(input: ChangeIdentity & { repo: string; base?: string }, cwd: string): string {
    const actor = this.identity(input), repo = input.repo.toLowerCase()
    // Preserve historical internal callers without granting that exception to Work-aware callers.
    return createHash('sha256').update(JSON.stringify(input.workKey === undefined
      ? [actor, cwd, repo, input.base ?? null] : [actor, cwd, repo, input.base ?? null, input.workKey])).digest('hex')
  }

  async prepare(input: ChangeIdentity & { repo: string; branchHint?: string; base?: string; operationKey?: string; attemptKey?: string;
    onPreparation?: (receipt: { id: string }) => void }): Promise<ChangePreparationResult> {
    const repo = input.repo.toLowerCase()
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo 必须是 owner/name')
    if (!this.opts.github.repoAllowed(repo)) throw new Error(`仓库 ${repo} 不在允许范围内`)
    const actor = this.identity(input)
    const check = () => { input.signal?.throwIfAborted(); input.assertAuthorized?.(); if (!this.opts.github.repoAllowed(repo)) throw new Error('仓库不再允许读取') }
    check()
    mkdirSync(input.cwd, { recursive: true })
    const cwd = realpathSync(input.cwd)
    mkdirSync(this.opts.cacheDir, { recursive: true, mode: 0o700 })
    const cacheRoot = realpathSync(this.opts.cacheDir)
    if (inside(cwd, cacheRoot) || cwd === cacheRoot) throw new Error('网关 Git 缓存必须位于 worker 工作区之外')
    const operationKey = input.operationKey ?? `legacy:${randomUUID()}`, attemptKey = input.attemptKey ?? 'initial'
    if (!operationKey.trim() || operationKey.length > 1000 || !attemptKey.trim() || attemptKey.length > 500) throw new Error('缺少可信的副本准备操作标识')
    const signature = this.preparationSignature(input, cwd)
    const existing = this.preparation({ ...input, operationKey })
    if (existing) {
      const prior = this.opts.db.prepare('SELECT signature FROM github_change_preparations WHERE id=?').get(existing.id)
      if (prior?.signature !== signature) throw new Error('相同准备操作已绑定另一份仓库或 base，请先查询原结果')
      input.onPreparation?.({ id: existing.id })
      check()
      if (existing.state === 'prepared' && existing.result) {
        // A durable success is historical evidence, not proof that its local copy still exists.
        // Never silently recreate it: the worker may already have edited or published that copy.
        const binding = this.binding(existing.result.dir)
        let available = false
        try {
          available = Boolean(binding && binding.id === existing.result.id && binding.cwd === cwd &&
            binding.sessionKey === actor.sessionKey && binding.requesterOpenId === actor.requesterOpenId &&
            binding.originWorkKey === (input.workKey ?? null) &&
            sameRepository(binding.repo, repo) && realpathSync(binding.dir) === existing.result.dir &&
            lstatSync(binding.dir).isDirectory() && lstatSync(join(binding.dir, '.git')).isDirectory() &&
            realpathSync(join(binding.dir, '.git')) === join(binding.dir, '.git') &&
            lstatSync(binding.gitDir).isDirectory() && realpathSync(binding.gitDir) === binding.gitDir)
        } catch { /* A missing or redirected local copy cannot be replayed as usable. */ }
        if (!available) throw new Error('原修改副本已不可用，准备记录仍保留；没有重新创建副本，请先核对原有改动。')
        check(); return { ...existing.result, replayed: true }
      }
      const flight = this.preparations.get(existing.id)
      if (flight) { const result = await waitForPreparation(flight, input.signal); check(); return { ...result, replayed: true } }
      if (existing.state === 'preparing' || existing.attemptKey === attemptKey) throw new ChangePreparationError(existing)
      // Preparation has no remote mutation. A distinct host-admitted Run may retry a settled local attempt;
      // repeated tools in the same Run may only query it. Neither path replays publishing.
      this.opts.db.prepare("UPDATE github_change_preparations SET state='preparing',attempt_key=?,error_code=NULL,updated_at=? WHERE id=? AND state!='prepared'")
        .run(attemptKey, this.now(), existing.id)
    }
    const operationId = existing?.id ?? randomUUID(), id = randomUUID()
    if (!existing) this.opts.db.prepare(`INSERT INTO github_change_preparations
      (id,operation_key,signature,session_key,requester_open_id,cwd,repo,attempt_key,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'preparing',?,?)`).run(operationId, operationKey, signature, actor.sessionKey, actor.requesterOpenId, cwd, repo, attemptKey, this.now(), this.now())
    if (!existing) {
      try { input.onPreparation?.({ id: operationId }); check() }
      catch (error) {
        this.opts.db.prepare("UPDATE github_change_preparations SET state='retryable',error_code='receipt_unavailable',updated_at=? WHERE id=?")
          .run(this.now(), operationId)
        throw error
      }
    }
    const operation = this.prepareCopy({ ...input, cwd, repo }, id, cacheRoot, check, result => {
      const changed = this.opts.db.prepare("UPDATE github_change_preparations SET state='prepared',result=?,error_code=NULL,updated_at=? WHERE id=? AND state='preparing' AND attempt_key=?")
        .run(JSON.stringify({ ...result, operationId }), this.now(), operationId, attemptKey)
      if (!changed.changes) throw new Error('副本准备的宿主执行已经变化')
    }).then(result => ({ ...result, operationId })).catch(error => {
      const state = input.signal?.aborted ? 'cancelled' : 'retryable'
      const code = input.signal?.aborted ? 'request_cancelled' : error instanceof ChangeGitError ? error.code : 'preparation_failed'
      this.opts.db.prepare("UPDATE github_change_preparations SET state=?,error_code=?,updated_at=? WHERE id=? AND state='preparing' AND attempt_key=?")
        .run(state, code, this.now(), operationId, attemptKey)
      throw error
    }).finally(() => { this.preparations.delete(operationId) })
    this.preparations.set(operationId, operation)
    return operation
  }

  private async prepareCopy(input: ChangeIdentity & { repo: string; branchHint?: string; base?: string }, id: string, cacheRoot: string,
    check: () => void, completed: (result: ChangePreparationResult) => void): Promise<ChangePreparationResult> {
    const { repo, cwd } = input, actor = this.identity(input)
    const base = input.base ?? await this.defaultBranch(repo, input)
    check()
    await this.git(['check-ref-format', '--branch', base], undefined, {}, check, input.signal)
    check()
    const cache = await this.ensureCache(repo, base, input)
    check()
    const baseCommit = await this.git(['rev-parse', '--verify', `refs/heads/${base}^{commit}`], cache, {}, check, input.signal)
    check()
    const branch = `friday/${slugify(input.branchHint ?? 'change')}-${id}`
    const work = join(cwd, 'work')
    mkdirSync(work, { recursive: true })
    if (realpathSync(work) !== work) throw new Error('work 目录不能通过符号链接跳转')
    const dir = join(work, id, repo.split('/')[1]!)
    mkdirSync(join(work, id))
    const trusted = join(cacheRoot, 'publish', id)
    mkdirSync(join(cacheRoot, 'publish'), { recursive: true, mode: 0o700 })
    try {
      await this.git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', cache, dir], undefined, {}, check, input.signal); check()
      await this.git(['remote', 'set-url', 'origin', this.remoteUrl(repo)], dir, {}, check, input.signal); check()
      await this.git(['checkout', '--quiet', '-b', branch, baseCommit], dir, {}, check, input.signal); check()
      await this.git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', cache, trusted], undefined, {}, check, input.signal); check()
      const gitDir = join(trusted, '.git'), createdAt = this.now()
      if (!existsSync(join(dir, MARKER_FILE))) writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ repo, base, branch, createdAt }, null, 2))
      for (const metadata of [join(dir, '.git'), gitDir]) writeFileSync(join(metadata, 'info', 'exclude'), `\n/${MARKER_FILE}\n`, { flag: 'a' })
      check()
      const result: ChangePreparationResult = { id, dir, branch, base, head: baseCommit, history: 'base_snapshot' }
      this.opts.db.exec('SAVEPOINT finish_change_preparation')
      try {
        this.opts.db.prepare('INSERT INTO github_changes (id, session_key, requester_open_id, origin_work_key, cwd, dir, repo, base, base_commit, branch, remote_url, git_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, actor.sessionKey, actor.requesterOpenId, input.workKey ?? null, cwd, dir, repo, base, baseCommit, branch, this.remoteUrl(repo), gitDir, createdAt, createdAt)
        completed(result)
        this.opts.db.exec('RELEASE SAVEPOINT finish_change_preparation')
      } catch (error) { this.opts.db.exec('ROLLBACK TO SAVEPOINT finish_change_preparation; RELEASE SAVEPOINT finish_change_preparation'); throw error }
      return result
    } catch (error) {
      // Generated paths were never returned or bound. Do not retain half-checkouts as reusable work.
      rmSync(join(work, id), { recursive: true, force: true }); rmSync(trusted, { recursive: true, force: true })
      throw error
    }
  }
  private binding(dir: string): ChangeBinding | undefined {
    let canonical: string
    try { canonical = realpathSync(dir) } catch { return undefined }
    const row = this.opts.db.prepare('SELECT * FROM github_changes WHERE dir = ?').get(canonical) as Record<string, unknown> | undefined
    return row ? toBinding(row) : undefined
  }
  /** 兼容读取接口，只返回网关 DB 登记；worker 的同名 JSON 没有授权作用。 */
  readMarker(dir: string): ChangeMarker | undefined {
    const binding = this.binding(dir)
    return binding ? { repo: binding.repo, branch: binding.branch, base: binding.base, createdAt: binding.createdAt } : undefined
  }
  /** An unsettled execution-output import stops every read, edit, check and
   * publication of that change except the owning import itself. */
  private assertImportSettled(changeId: string, owner?: string): void {
    const pending = pendingExecutionImport(this.opts.db, changeId)
    if (pending && pending.id !== owner) throw new RepositoryExecutionImportPending(pending.id, pending.state)
  }
  private async validate(input: ChangeIdentity & { dir: string; importOwner?: string }): Promise<ChangeBinding> {
    const actor = this.identity(input)
    const binding = this.binding(input.dir)
    if (!binding) throw new Error('这个目录不是 github_start_change 在网关登记的修改副本')
    this.assertImportSettled(binding.id, input.importOwner)
    const cwd = realpathSync(input.cwd)
    if (binding.cwd !== cwd || binding.sessionKey !== actor.sessionKey || binding.requesterOpenId !== actor.requesterOpenId) throw new ChangeAccessError('修改副本不属于当前会话与发起人')
    this.assertWork(binding, input)
    if (!inside(cwd, binding.dir) || realpathSync(binding.dir) !== binding.dir) throw new Error('修改副本的实际路径已经改变')
    const metadata = join(binding.dir, '.git')
    if (!lstatSync(metadata).isDirectory() || realpathSync(metadata) !== metadata) throw new Error('修改副本的 Git 目录已经改变')
    if (!this.opts.github.repoAllowed(binding.repo)) throw new Error('发布仓库或远端不再符合网关配置')
    this.gitTarget(binding.repo, binding.remoteUrl)
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], binding.dir, {}, input.assertAuthorized, input.signal)
    const top = await this.git(['rev-parse', '--show-toplevel'], binding.dir, {}, input.assertAuthorized, input.signal)
    const remote = await this.git(['config', '--local', '--no-includes', '--get', 'remote.origin.url'], binding.dir, {}, input.assertAuthorized, input.signal)
    if (branch !== binding.branch || realpathSync(top) !== binding.dir || remote !== binding.remoteUrl) throw new Error('修改副本的分支、工作树或远端与登记不符')
    await this.git(['merge-base', '--is-ancestor', binding.baseCommit, 'HEAD'], binding.dir, {}, input.assertAuthorized, input.signal)
    return binding
  }
  private async snapshot(binding: ChangeBinding, comparisonCommit = binding.baseCommit, input?: ChangeIdentity): Promise<{ snapshot: string; files: string[]; stat: string }> {
    const args = [`--git-dir=${binding.gitDir}`, `--work-tree=${binding.dir}`]
    // 索引与配置属于网关，worker 的 hooks、filters、index、remotes 不参与发布。
    await this.git([...args, 'read-tree', comparisonCommit], undefined, {}, input?.assertAuthorized, input?.signal)
    await this.git([...args, 'add', '-A', '--', '.'], binding.dir, {}, input?.assertAuthorized, input?.signal)
    await this.git([...args, 'reset', '--quiet', comparisonCommit, '--', MARKER_FILE], binding.dir, {}, input?.assertAuthorized, input?.signal)
    const snapshot = await this.git([...args, 'write-tree'], undefined, {}, input?.assertAuthorized, input?.signal)
    const changed = await this.git([`--git-dir=${binding.gitDir}`, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', comparisonCommit, snapshot], undefined, {}, input?.assertAuthorized, input?.signal)
    const stat = await this.git([`--git-dir=${binding.gitDir}`, 'diff', '--no-ext-diff', '--no-textconv', '--stat', comparisonCommit, snapshot], undefined, {}, input?.assertAuthorized, input?.signal)
    return { snapshot, files: changed.split('\0').filter(Boolean), stat }
  }
  async inspect(input: ChangeIdentity & { dir: string }): Promise<ChangeInspection> {
    return this.queue.run(`publish:${this.binding(input.dir)?.id ?? resolve(input.dir)}`, async () => {
      const binding = await this.validate(input)
      const summary = await this.snapshot(binding, binding.baseCommit, input)
      return { id: binding.id, dir: binding.dir, repo: binding.repo, base: binding.base, baseCommit: binding.baseCommit, branch: binding.branch, createdAt: binding.createdAt, head: await this.git(['rev-parse', 'HEAD'], binding.dir, {}, input.assertAuthorized, input.signal), ...summary }
    })
  }
  /** Host file bridge shares the publisher lock and resolves paths exclusively
   * from the trusted binding. Pending external writes must reconcile first. */
  async withChange<T>(input: ChangeIdentity & { id: string; assertAuthorized: () => void; importOwner?: string },
    use: (change: ChangeFileLease) => Promise<T>): Promise<T> {
    input.assertAuthorized()
    return this.queue.run(`publish:${input.id}`, async () => {
      input.assertAuthorized()
      const row = this.opts.db.prepare('SELECT * FROM github_changes WHERE id=?').get(input.id)
      if (!row) throw new Error('当前会话没有这份修改副本')
      const original = toBinding(row), identity = { ...input, dir: original.dir }
      const binding = await this.validate(identity), captured = JSON.stringify(binding)
      const assertCurrent = () => {
        input.assertAuthorized()
        if (input.signal?.aborted) throw new Error('修改副本操作已停止')
        const current = this.opts.db.prepare('SELECT * FROM github_changes WHERE id=?').get(input.id)
        if (!current || JSON.stringify(toBinding(current)) !== captured ||
          !['prepared', 'confirmed'].includes(String(current.state)) ||
          this.opts.db.prepare("SELECT 1 FROM github_change_updates WHERE change_id=? AND state!='confirmed'").get(input.id)) {
          throw new Error('修改副本已有待核对的发布操作，请先核对原结果')
        }
        this.assertImportSettled(input.id, input.importOwner)
        if (!this.opts.github.repoAllowed(binding.repo) || realpathSync(binding.dir) !== binding.dir) {
          throw new Error('修改副本的仓库授权或实际目录已变化')
        }
      }
      assertCurrent()
      const result = await use({ id: binding.id, repo: binding.repo, dir: binding.dir, assertCurrent,
        snapshot: async () => { assertCurrent(); const value = await this.snapshot(binding, binding.baseCommit, { ...input, assertAuthorized: assertCurrent });
          assertCurrent(); return value.snapshot },
        pathInventory: async path => {
          assertCurrent()
          if (typeof path !== 'string' || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path)
            || (path && path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part === MARKER_FILE))) {
            throw new ChangeAccessError('路径清单必须限于当前修改副本中的相对范围')
          }
          let output: string
          try {
            // --with-tree includes base-tracked paths even before the trusted
            // private index has ever been populated; a tracked ignored file is
            // still eligible. Never read the worker-controlled index/config.
            output = await this.git([`--git-dir=${binding.gitDir}`, `--work-tree=${binding.dir}`, 'ls-files',
              '--cached', '--others', '--exclude-standard', `--with-tree=${binding.baseCommit}`, '-z', '--',
              path ? `:(top,literal)${path}` : '.'], binding.dir, {}, assertCurrent, input.signal, true)
          } catch (error) {
            assertCurrent()
            if (error instanceof ChangeGitError && error.code === 'output_limit') return { paths: [], complete: false }
            throw error
          }
          assertCurrent()
          const paths = output.split('\0').filter(Boolean)
          return paths.length > 50_000 ? { paths: paths.slice(0, 50_000), complete: false } : { paths, complete: true }
        },
        stageOutput: async (baseTree, patch) => {
          assertCurrent()
          if (!/^[a-f0-9]{40}$/.test(baseTree) || !Buffer.isBuffer(patch) || !patch.length || patch.length > 2 * 1024 * 1024) {
            throw new ChangeAccessError('执行结果补丁或基线无效')
          }
          // Scratch lives inside the gateway-owned Git directory, never in the worker's checkout.
          const scratch = mkdtempSync(join(binding.gitDir, 'friday-output-'))
          try {
            const empty = join(scratch, 'empty'), patchFile = join(scratch, 'output.patch')
            mkdirSync(empty, { mode: 0o700 })
            writeFileSync(patchFile, patch, { mode: 0o600, flag: 'wx' })
            const git = (args: string[], output = false) => this.git([`--git-dir=${binding.gitDir}`, `--work-tree=${empty}`, ...args],
              empty, { GIT_INDEX_FILE: join(scratch, 'index') }, assertCurrent, input.signal, output)
            await git(['read-tree', baseTree])
            // Exact preimages only: no fuzz, whitespace repair or three-way fallback.
            await git(['apply', '--cached', '--binary', '--whitespace=nowarn', '--', patchFile])
            const tree = await git(['write-tree'])
            const raw = await git(['diff-tree', '-r', '-z', '--no-renames', '--raw', '--full-index', baseTree, tree], true)
            assertCurrent()
            return { tree, entries: parseTreeDiff(raw) }
          } finally { rmSync(scratch, { recursive: true, force: true }) }
        },
        readBlob: async blob => {
          assertCurrent()
          if (!/^[a-f0-9]{40}$/.test(blob)) throw new ChangeAccessError('blob 标识无效')
          const text = await this.git([`--git-dir=${binding.gitDir}`, 'cat-file', 'blob', blob], undefined, {}, assertCurrent, input.signal, true)
          assertCurrent()
          return Buffer.from(text, 'utf8')
        },
      })
      assertCurrent()
      return result
    })
  }
  /** Export the exact trusted tree while holding the same edit/publish lock.
   * Preserve patch bytes, including terminal newlines; no credentials or host paths. */
  async executionSnapshot(input: ChangeIdentity & { changeId: string; expectedSnapshot: string; assertAuthorized(): void }) {
    return this.withChange({ ...input, id: input.changeId }, async lease => {
      const snapshot = await lease.snapshot()
      if (snapshot !== input.expectedSnapshot) throw new ChangeSnapshotError()
      const binding = this.binding(lease.dir)!
      const patch = await this.git([`--git-dir=${binding.gitDir}`, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
        binding.baseCommit, snapshot, '--'], undefined, {}, lease.assertCurrent, input.signal, true)
      lease.assertCurrent()
      if (Buffer.byteLength(patch) > 2 * 1024 * 1024) throw new Error('这份修改超出当前执行器的补丁大小，请缩小这次验证范围')
      if (await lease.snapshot() !== snapshot) throw new ChangeSnapshotError()
      lease.assertCurrent()
      return { repo: binding.repo, baseSha: binding.baseCommit, inputTree: snapshot, patch }
    })
  }

  /** 旧摘要接口不读 worker 配置；授权入口应使用 inspect。 */
  async summarize(dir: string, identity?: ChangeIdentity): Promise<{ files: string[]; stat: string }> {
    const binding = this.binding(dir)
    if (!binding) throw new Error('这个目录不是 github_start_change 在网关登记的修改副本')
    this.assertWork(binding, identity ?? { cwd: binding.cwd })
    return this.queue.run(`publish:${binding.id}`, () => this.snapshot(binding))
  }
  /** 仅登记索引（cwd 存在时规范化路径），不运行 Git/访问网络；旧目录消失也保留登记。 */
  list(input: ChangeIdentity): ChangeListEntry[] {
    const actor = this.identity(input)
    input.assertAuthorized?.()
    let cwd = resolve(input.cwd)
    try { cwd = realpathSync(cwd) } catch { /* 仍可按原规范路径读取登记 */ }
    const rows = this.opts.db.prepare('SELECT * FROM github_changes WHERE cwd = ? AND session_key = ? AND requester_open_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(cwd, actor.sessionKey, actor.requesterOpenId) as Record<string, unknown>[]
    return rows.map((row) => {
      const binding = toBinding(row), pending = this.pendingUpdate(binding.id)
      return { id: binding.id, dir: binding.dir, repo: binding.repo, base: binding.base, branch: binding.branch,
        state: pending ? `update_${pending.state}` : binding.state, prNumber: binding.prNumber, prUrl: binding.prUrl,
        commitId: this.latestHead(binding),
        ...(input.workKey !== undefined || binding.originWorkKey !== null ? { workAccess: binding.originWorkKey === null ? 'legacy_unbound' as const
          : binding.originWorkKey === input.workKey ? 'current' as const : 'other_work' as const } : {}) }
    })
  }
  private pendingUpdate(id: string): ChangeUpdate | undefined {
    const row = this.opts.db.prepare("SELECT * FROM github_change_updates WHERE change_id = ? AND state != 'confirmed'").get(id) as Record<string, unknown> | undefined
    return row ? toChangeUpdate(row) : undefined
  }
  private latestHead(binding: ChangeBinding): string | null {
    const row = this.opts.db.prepare("SELECT commit_id FROM github_change_updates WHERE change_id = ? AND state = 'confirmed' ORDER BY rowid DESC LIMIT 1").get(binding.id)
    return row ? String(row.commit_id) : binding.commitId
  }
  confirmedPublication(changeId: string): ConfirmedPublication | undefined {
    const row = this.opts.db.prepare('SELECT * FROM github_changes WHERE id=?').get(changeId) as Record<string, unknown> | undefined
    if (!row) return undefined
    const binding = toBinding(row)
    if (!binding.originWorkKey || binding.state !== 'confirmed' || binding.result?.phase !== 'confirmed' ||
      !binding.prNumber || !binding.prUrl || !binding.commitId || !binding.snapshot || this.pendingUpdate(changeId)) return undefined
    const update = this.opts.db.prepare("SELECT commit_id,snapshot FROM github_change_updates WHERE change_id=? AND state='confirmed' ORDER BY rowid DESC LIMIT 1").get(changeId)
    return { changeId, repo: binding.repo, number: binding.prNumber, url: binding.prUrl,
      head: update ? String(update.commit_id) : binding.commitId, snapshot: update ? String(update.snapshot) : binding.snapshot,
      workKey: binding.originWorkKey, sessionKey: binding.sessionKey, requesterOpenId: binding.requesterOpenId }
  }
  private requirePublished(binding: ChangeBinding): void {
    if (binding.state !== 'confirmed' || !binding.prNumber || binding.result?.phase !== 'confirmed' || !binding.commitId) {
      throw new Error('须先核对首次 PR 发布结果，确认后才能追加提交')
    }
  }
  private async activePr(binding: ChangeBinding, input: ChangeIdentity): Promise<{ head: string; url: string }> {
    input.assertAuthorized?.()
    const pr = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${binding.repo}/pulls/${binding.prNumber}`, undefined, binding.repo.split('/')[0], input.assertAuthorized, input.signal)
    input.assertAuthorized?.()
    if (Number(pr.number) !== binding.prNumber || !matchesPrBranch(pr, binding)) throw new Error('远端 PR 的编号、仓库、head 或 base 与登记不符')
    if (pr.state !== 'open' || pr.merged === true || pr.merged_at != null) throw new Error('PR 已关闭或合并，不能追加提交')
    const head = (pr.head as { sha?: string }).sha, url = pr.html_url
    if (!head || typeof url !== 'string' || !url) throw new Error('远端 PR 没有返回 head 或链接')
    return { head, url }
  }
  private async remoteHead(binding: ChangeBinding, input: ChangeIdentity, env?: Record<string, string>): Promise<string> {
    const auth = env ?? await this.authEnv(binding.repo, input.signal, binding.remoteUrl)
    input.assertAuthorized?.()
    const ref = `refs/heads/${binding.branch}`
    const output = await this.git([`--git-dir=${binding.gitDir}`, 'ls-remote', '--heads', this.gitTarget(binding.repo,binding.remoteUrl).url, ref], undefined, auth, input.assertAuthorized, input.signal)
    input.assertAuthorized?.()
    const lines = output.split('\n').filter(Boolean).map((line) => line.split(/\s+/))
    if (lines.length !== 1 || lines[0]?.[1] !== ref) throw new Error('远端 PR 分支不存在或不能唯一确认')
    return lines[0]![0]!
  }
  private updateAttempt(id: string, fields: Record<string, string | null>): void {
    const entries = Object.entries(fields)
    this.opts.db.prepare(`UPDATE github_change_updates SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), this.now(), id)
  }
  async inspectUpdate(input: ChangeIdentity & { dir: string }): Promise<ChangeUpdateInspection> {
    return this.queue.run(`publish:${this.binding(input.dir)?.id ?? resolve(input.dir)}`, async () => {
      const binding = await this.validate(input)
      input.assertAuthorized?.()
      this.requirePublished(binding)
      const pending = this.pendingUpdate(binding.id), expectedHead = pending?.parentCommit ?? this.latestHead(binding)!
      const summary = await this.snapshot(binding, expectedHead, input)
      input.assertAuthorized?.()
      if (pending && summary.snapshot !== pending.snapshot) throw new Error('尚有未确认的追加提交，工作区已变化；请先核对原追加结果')
      const pr = await this.activePr(binding, input), remote = await this.remoteHead(binding, input)
      // 已推送但回读尚未完成时，保留这一次审批的 parent/tree，而非开启另一轮更新。
      const allowed = new Set([expectedHead, ...(pending && pending.state !== 'prepared' ? [pending.commitId] : [])])
      if (!allowed.has(pr.head) || !allowed.has(remote)) throw new Error('远端 PR head 已变化，不能覆盖其他提交')
      return { id: binding.id, dir: binding.dir, repo: binding.repo, base: binding.base, baseCommit: binding.baseCommit,
        branch: binding.branch, createdAt: binding.createdAt, head: expectedHead, expectedHead,
        prNumber: binding.prNumber!, prUrl: pr.url, noChanges: summary.files.length === 0, ...summary }
    })
  }
  async updatePr(input: ChangeIdentity & { dir: string; title: string; body: string; expectedSnapshot: string; expectedHead: string }): Promise<ChangeResult> {
    return this.queue.run(`publish:${this.binding(input.dir)?.id ?? resolve(input.dir)}`, async () => {
      const binding = await this.validate(input)
      input.assertAuthorized?.()
      this.requirePublished(binding)
      if (!input.expectedSnapshot || !input.expectedHead) throw new Error('追加提交需要确认时的快照和 PR head')
      const title = input.title.trim().slice(0, 200), body = input.body.trim()
      if (!title) throw new Error('需要本次追加提交的标题')
      const intent = createHash('sha256').update(JSON.stringify({ title, body })).digest('hex')
      let attempt = this.pendingUpdate(binding.id)
      if (attempt && (attempt.parentCommit !== input.expectedHead || attempt.snapshot !== input.expectedSnapshot || attempt.intent !== intent)) {
        throw new Error('尚有未确认的追加提交，不能用新内容跳过原结果')
      }
      if (!attempt) {
        const row = this.opts.db.prepare('SELECT * FROM github_change_updates WHERE change_id = ? AND parent_commit = ? AND snapshot = ? AND intent = ?')
          .get(binding.id, input.expectedHead, input.expectedSnapshot, intent) as Record<string, unknown> | undefined
        if (row) attempt = toChangeUpdate(row)
        else if (input.expectedHead !== this.latestHead(binding)) throw new Error('确认的 PR head 已过期，请重新检查改动')
      }
      const summary = await this.snapshot(binding, input.expectedHead, input)
      input.assertAuthorized?.()
      if (summary.snapshot !== input.expectedSnapshot) throw new Error('改动已在确认后变化，请先核对原追加结果')
      if (!summary.files.length) throw new Error('相对上次确认的 PR head 没有新增改动')
      const confirm = async (current: ChangeUpdate, replayed: boolean): Promise<ChangeResult> => {
        // Only a durable push ACK permits waiting for the two read surfaces to
        // catch up. An unknown push retains its existing single-read recovery.
        const acknowledged = this.opts.db.prepare('SELECT state FROM github_change_updates WHERE id = ? AND change_id = ?')
          .get(current.id, binding.id)?.state === 'pushed'
        const rounds = acknowledged ? 3 : 1
        for (let round = 0; round < rounds; round++) {
          input.signal?.throwIfAborted(); input.assertAuthorized?.()
          const pr = await this.activePr(binding, input)
          input.signal?.throwIfAborted(); input.assertAuthorized?.()
          const remote = await this.remoteHead(binding, input)
          input.signal?.throwIfAborted(); input.assertAuthorized?.()
          if (remote === current.commitId && pr.head === current.commitId) {
            const result: ChangeResult = { url: pr.url, number: binding.prNumber!, branch: binding.branch, base: binding.base,
              repo: binding.repo, files: summary.files, head: pr.head, phase: 'confirmed' }
            this.updateAttempt(current.id, { state: 'confirmed', result: JSON.stringify(result), error: null })
            return replayed ? { ...result, replayed: true } : result
          }
          // Commit identities and attempt ids are sufficient to diagnose stale
          // readback; no request bodies, credentials or checkout paths are logged.
          this.opts.log.warn('github update readback not synchronized', { changeId: binding.id, updateId: current.id,
            round: round + 1, acknowledged, parentHead: current.parentCommit, expectedHead: current.commitId,
            prHead: pr.head, remoteHead: remote })
          if (!acknowledged) throw new Error(UNKNOWN_UPDATE)
          if (![pr.head, remote].every(head => head === current.parentCommit || head === current.commitId)) {
            throw new Error('推送已完成，但远端 PR 或分支出现其他提交；须核对，不会重复推送')
          }
          if (round + 1 < rounds) {
            await delay((round + 1) * 1_000, undefined, { signal: input.signal })
            input.signal?.throwIfAborted(); input.assertAuthorized?.()
          }
        }
        throw new Error(UPDATE_SYNC_PENDING)
      }
      // 即使远端仍是旧 head，也不能由一次不确定的 push 自动重推。
      if (attempt && attempt.state !== 'prepared') return confirm(attempt, true)
      const pr = await this.activePr(binding, input), remote = await this.remoteHead(binding, input)
      if (pr.head !== input.expectedHead || remote !== input.expectedHead) throw new Error('远端 PR head 已变化，不能覆盖其他提交')
      if (!attempt) {
        const author = this.opts.author ?? await this.opts.github.botAuthor(input.signal)
        input.assertAuthorized?.()
        const commit = await this.git([`--git-dir=${binding.gitDir}`, 'commit-tree', summary.snapshot, '-p', input.expectedHead, '-m', title, '-m', body], undefined, {
          GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
        }, input.assertAuthorized, input.signal)
        input.assertAuthorized?.()
        attempt = { id: randomUUID(), parentCommit: input.expectedHead, snapshot: summary.snapshot, intent, commitId: commit, state: 'prepared', result: null }
        this.opts.db.prepare('INSERT INTO github_change_updates (id, change_id, parent_commit, snapshot, intent, commit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(attempt.id, binding.id, attempt.parentCommit, attempt.snapshot, intent, commit, this.now(), this.now())
      }
      // 取 token/再次校验期间失败仍是 prepared，可在重新授权后重试；此时尚未对外写入。
      const env = await this.authEnv(binding.repo, input.signal, binding.remoteUrl)
      input.assertAuthorized?.()
      await this.validate(input)
      input.assertAuthorized?.()
      const beforePushPr = await this.activePr(binding, input), beforePushRef = await this.remoteHead(binding, input, env)
      if (beforePushPr.head !== attempt.parentCommit || beforePushRef !== attempt.parentCommit) throw new Error('远端 PR head 已变化，不能覆盖其他提交')
      const checked = await this.snapshot(binding, attempt.parentCommit, input)
      input.assertAuthorized?.()
      if (checked.snapshot !== attempt.snapshot) throw new Error('改动已在确认后变化，请先核对原追加结果')
      let started = false
      try {
        await this.git([`--git-dir=${binding.gitDir}`, 'push', '--quiet', `--force-with-lease=refs/heads/${binding.branch}:${attempt.parentCommit}`,
          this.gitTarget(binding.repo,binding.remoteUrl).url, `${attempt.commitId}:refs/heads/${binding.branch}`], undefined, env, () => {
          input.assertAuthorized?.()
          this.updateAttempt(attempt!.id, { state: 'push_planned', error: null })
          started = true
        }, input.signal)
        this.updateAttempt(attempt.id, { state: 'pushed' })
      } catch (err) {
        if (!started) throw err
        try { this.updateAttempt(attempt.id, { state: 'unknown', error: String(err).slice(0, 500) }) } catch { /* push_planned 同样禁止盲目重推 */ }
        throw new Error(UNKNOWN_UPDATE, { cause: err })
      }
      return confirm(attempt, false)
    })
  }
  private update(id: string, fields: Record<string, string | number | null>): void {
    const entries = Object.entries(fields)
    this.opts.db.prepare(`UPDATE github_changes SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), this.now(), id)
  }
  /**
   * draft → 可评审，并回报 PR 现在的状态。
   *
   * 开 PR 一律是 draft（"提交了，但测试和演示还在补"），这是刻意的：
   * 到底就绪没有，只有做事的人知道，不该由创建那一刻替他宣布。
   * 所以"就绪"是一次**单独的显式动作**——就像人手动点 Ready for review 一样。
   *
   * REST 改不了 draft 标记（PATCH /pulls 不认这个字段），只有 GraphQL 的
   * markPullRequestReadyForReview 能做，所以这里走一次 GraphQL。
   * 幂等：已经就绪了就直接回报，不报错、不重复调用。
   */
  async markReady(input: ChangeIdentity & { dir: string }): Promise<PrLifecycle> {
    const binding = this.binding(input.dir)
    if (!binding) throw new Error('这个目录没有登记过修改副本')
    if (binding.sessionKey !== input.sessionKey || binding.requesterOpenId !== input.requesterOpenId) {
      throw new Error('GitHub：修改副本不属于当前会话与发起人')
    }
    this.assertWork(binding, input)
    if (!binding.prNumber) throw new Error('这份修改还没有 PR，先发布再说就绪')
    const owner = binding.repo.split('/')[0]
    const pr = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${binding.repo}/pulls/${binding.prNumber}`, undefined, owner, input.assertAuthorized, input.signal)
    if (!matchesPrBranch(pr, binding)) throw new Error('远端 PR 的仓库、head 或 base 与本次修改不符')
    const before = this.lifecycleOf(pr, binding.repo, binding.prNumber)
    if (before.merged || !before.draft) return before
    const nodeId = typeof pr.node_id === 'string' ? pr.node_id : ''
    if (!nodeId) throw new Error('读不到 PR 的 node_id，无法标记就绪')
    input.assertAuthorized?.()
    await this.opts.github.api<unknown>('POST', '/graphql', {
      query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}',
      variables: { id: nodeId },
    }, owner, input.assertAuthorized, input.signal)
    // 回读确认，不拿"请求没报错"当成"已经就绪"
    const after = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${binding.repo}/pulls/${binding.prNumber}`, undefined, owner, input.assertAuthorized, input.signal)
    return this.lifecycleOf(after, binding.repo, binding.prNumber)
  }

  /** PR 现在处在哪一段：draft / 待评审 / 已合并 / 已关闭未合并。只读。 */
  async lifecycle(input: ChangeIdentity & { dir: string }): Promise<PrLifecycle> {
    const binding = this.binding(input.dir)
    if (!binding) throw new Error('这个目录没有登记过修改副本')
    if (binding.sessionKey !== input.sessionKey || binding.requesterOpenId !== input.requesterOpenId) throw new Error('GitHub：修改副本不属于当前会话与发起人')
    this.assertWork(binding, input)
    if (!binding.prNumber) throw new Error('这份修改还没有 PR')
    const pr = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${binding.repo}/pulls/${binding.prNumber}`, undefined, binding.repo.split('/')[0], input.assertAuthorized, input.signal)
    if (!matchesPrBranch(pr, binding)) throw new Error('远端 PR 的仓库、head 或 base 与本次修改不符')
    return this.lifecycleOf(pr, binding.repo, binding.prNumber)
  }

  /**
   * 按仓库和编号读 PR 状态 + 有没有人 review 过。给轮询用。
   *
   * 不做 binding 归属校验：调用方给的就是 `github_changes` 里我们自己开的那条，
   * 归属在取这条记录的时候就定了。这里只关心"它现在怎么样了"。
   */
  async poll(repo: string, number: number): Promise<PrLifecycle & { reviewed: boolean; mergeCommitSha: string | null; mergedAt: number | null }> {
    const owner = repo.split('/')[0]
    const pr = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${repo}/pulls/${number}`, undefined, owner)
    const life = this.lifecycleOf(pr, repo, number)
    // 合并提交与合并时间：之后查"进了哪个发布版本"要用（合并之前发布的版本不用比）
    const mergedAtRaw = typeof pr.merged_at === 'string' ? Date.parse(pr.merged_at) : NaN
    const merge = {
      mergeCommitSha: life.merged && typeof pr.merge_commit_sha === 'string' && pr.merge_commit_sha ? pr.merge_commit_sha : null,
      mergedAt: life.merged && Number.isFinite(mergedAtRaw) ? mergedAtRaw : null,
    }
    if (life.merged || life.closed || life.draft) return { ...life, reviewed: false, ...merge }
    const reviews = await this.opts.github.api<unknown[]>('GET', `/repos/${repo}/pulls/${number}/reviews?per_page=1`, undefined, owner)
      .catch(() => [] as unknown[])
    return { ...life, reviewed: Array.isArray(reviews) && reviews.length > 0, ...merge }
  }

  /**
   * PR 上某时刻之后新建的回复：普通评论、代码行评论和 review（含批准、要求修改）。只读，每类最多 100 条。
   * 代码行评论如果是在回复另一条评论，带上被回复那条的正文作上下文；找不到就不带（判定时算上下文不完整）。
   */
  async replies(repo: string, number: number, sinceMs: number): Promise<PrReplyItem[]> {
    const owner = repo.split('/')[0]
    const since = encodeURIComponent(new Date(sinceMs).toISOString())
    type Raw = { id?: unknown; user?: { login?: unknown } | null; body?: unknown; created_at?: unknown; submitted_at?: unknown; html_url?: unknown; state?: unknown; in_reply_to_id?: unknown }
    const [issueComments, reviewComments, reviews] = await Promise.all([
      this.opts.github.api<Raw[]>('GET', `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`, undefined, owner),
      this.opts.github.api<Raw[]>('GET', `/repos/${repo}/pulls/${number}/comments?since=${since}&per_page=100`, undefined, owner),
      this.opts.github.api<Raw[]>('GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`, undefined, owner),
    ])
    const item = (kind: PrReplyItem['kind'], raw: Raw, at: unknown): PrReplyItem | undefined => {
      const createdAt = typeof at === 'string' ? Date.parse(at) : NaN
      const author = typeof raw.user?.login === 'string' ? raw.user.login : ''
      if (!Number.isSafeInteger(raw.id) || !author || !Number.isFinite(createdAt) || createdAt <= sinceMs) return undefined
      return { key: `${kind}:${raw.id}`, kind, author, body: typeof raw.body === 'string' ? raw.body : '', createdAt,
        url: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${repo}/pull/${number}`,
        ...(kind === 'review' && typeof raw.state === 'string' ? { state: raw.state } : {}) }
    }
    const list = (value: unknown): Raw[] => Array.isArray(value) ? value as Raw[] : []
    const lineComments = list(reviewComments)
    const out: PrReplyItem[] = []
    for (const raw of list(issueComments)) { const value = item('issue_comment', raw, raw.created_at); if (value) out.push(value) }
    for (const raw of lineComments) {
      const value = item('review_comment', raw, raw.created_at)
      if (!value) continue
      const parent = Number.isSafeInteger(raw.in_reply_to_id) ? lineComments.find(other => other.id === raw.in_reply_to_id) : undefined
      out.push(parent && typeof parent.body === 'string' ? { ...value, parentBody: parent.body } : value)
    }
    // A pending review has no submission time yet; it is not a reply until submitted.
    for (const raw of list(reviews)) { const value = item('review', raw, raw.submitted_at); if (value && raw.state !== 'PENDING') out.push(value) }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 这个 PR 关闭（closes / fixes / resolves，或在 GitHub 上手动关联）的 Issue。给"进入发布版本后回告原报障人"用。
   *
   * 用 GitHub 自己的关联（GraphQL `closingIssuesReferences`），不自己解析正文里的关键字：
   * 手动关联的也算，正文里写了但被 GitHub 判为无效引用的不算。只读；读不到就抛错，由调用方决定这一轮跳过。
   */
  async closingIssues(repo: string, number: number): Promise<{ repo: string; number: number; url: string }[]> {
    const [owner, name] = repo.split('/')
    const res = await this.opts.github.api<{ data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes?: unknown[] } } | null } | null }; errors?: unknown[] }>('POST', '/graphql', {
      query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:20){nodes{number url repository{nameWithOwner}}}}}}',
      variables: { owner, name, number },
    }, owner)
    const pull = res?.data?.repository?.pullRequest
    if (!pull) throw new Error(`GitHub：读不到 ${repo}#${number} 关闭的 Issue${Array.isArray(res?.errors) && res.errors.length ? '（GraphQL 返回错误）' : ''}`)
    const out: { repo: string; number: number; url: string }[] = []
    for (const node of pull.closingIssuesReferences?.nodes ?? []) {
      const n = node as { number?: unknown; url?: unknown; repository?: { nameWithOwner?: unknown } } | null
      const num = Number(n?.number), url = typeof n?.url === 'string' ? n.url : '', full = typeof n?.repository?.nameWithOwner === 'string' ? n.repository.nameWithOwner : ''
      if (!Number.isSafeInteger(num) || num <= 0 || !url || !full) continue
      out.push({ repo: full, number: num, url })
    }
    return out
  }

  private lifecycleOf(pr: Record<string, unknown>, repo: string, number: number): PrLifecycle {
    const merged = pr.merged === true || typeof pr.merged_at === 'string'
    const draft = pr.draft === true
    return {
      repo, number, url: String(pr.html_url ?? ''), draft, merged,
      closed: pr.state === 'closed' && !merged,
      phase: merged ? 'merged' : pr.state === 'closed' ? 'closed' : draft ? 'draft' : 'ready',
    }
  }

  private async readPr(binding: ChangeBinding, number: number, files: string[], input: ChangeIdentity): Promise<ChangeResult> {
    const pr = await this.opts.github.api<Record<string, unknown>>('GET', `/repos/${binding.repo}/pulls/${number}`, undefined, binding.repo.split('/')[0], input.assertAuthorized, input.signal)
    if (!matchesPr(pr, binding)) throw new Error('远端 PR 的仓库、head 或 base 与本次修改不符')
    const result: ChangeResult = { url: String(pr.html_url ?? ''), number, branch: binding.branch, base: binding.base, repo: binding.repo, files, head: binding.commitId!, phase: 'confirmed' }
    if (!result.url) throw new Error('远端 PR 没有返回链接')
    this.update(binding.id, { state: 'confirmed', pr_number: number, pr_url: result.url, result: JSON.stringify(result), error: null })
    return result
  }
  private async findPr(binding: ChangeBinding, input: ChangeIdentity): Promise<number | undefined> {
    const query = new URLSearchParams({ state: 'all', head: `${binding.repo.split('/')[0]}:${binding.branch}`, base: binding.base, per_page: '100' })
    const found = await this.opts.github.api<Record<string, unknown>[]>('GET', `/repos/${binding.repo}/pulls?${query}`, undefined, binding.repo.split('/')[0], input.assertAuthorized, input.signal)
    const matching = found.filter((pr) => matchesPrBranch(pr, binding))
    if (matching.length > 1) throw new Error('同一修改对应多个 PR，需要人工核对')
    if (!matching.length) return undefined
    if (!matchesPr(matching[0]!, binding)) throw new Error('远端 PR 的 head 提交与本次修改不符，需要人工核对')
    const number = Number(matching[0]!.number)
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('查询 PR 没有返回有效编号，不能继续创建')
    return number
  }
  async publish(input: ChangeIdentity & { dir: string; title: string; body: string; draft?: boolean; expectedSnapshot?: string }): Promise<ChangeResult> {
    return this.queue.run(`publish:${this.binding(input.dir)?.id ?? resolve(input.dir)}`, async () => {
      let binding = await this.validate(input)
      if (!input.expectedSnapshot) throw new Error('发布需要确认时的改动快照')
      if (input.draft === false) throw new Error('当前发布只支持 draft PR')
      const title = input.title.trim().slice(0, 200)
      if (!title) throw new Error('需要 PR 标题')
      const summary = await this.snapshot(binding, binding.baseCommit, input)
      if (summary.snapshot !== input.expectedSnapshot) throw new Error('改动已在确认后变化，请重新检查并确认')
      if (!summary.files.length) throw new Error('没有任何改动可提交')
      const intent = createHash('sha256').update(JSON.stringify({ title, body: input.body.trim(), draft: true })).digest('hex')
      if (binding.publishIntent && (binding.publishIntent !== intent || binding.snapshot !== summary.snapshot)) {
        throw new Error(binding.state === 'confirmed'
          ? '该副本已开始发布其他改动；review 后追加提交请使用 github_update_pr'
          : '该副本已开始发布其他改动；请先核对原发布结果，不能用新内容跳过')
      }
      if (binding.state === 'confirmed' && binding.result) return { ...binding.result, replayed: true }
      if (binding.state === 'prepared') {
        const author = this.opts.author ?? await this.opts.github.botAuthor(input.signal)
        const commit = await this.git([`--git-dir=${binding.gitDir}`, 'commit-tree', summary.snapshot, '-p', binding.baseCommit, '-m', title, '-m', input.body.trim()], undefined, {
          GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
        }, input.assertAuthorized, input.signal)
        this.update(binding.id, { state: 'push_planned', snapshot: summary.snapshot, publish_intent: intent, commit_id: commit })
        binding = this.binding(binding.dir)!
      }
      if (binding.state === 'push_planned') {
        const env = await this.authEnv(binding.repo, input.signal, binding.remoteUrl)
        // 推送中断后先查精确 ref；同一 commit 可确认，其他内容不能覆盖。
        const remote = await this.git([`--git-dir=${binding.gitDir}`, 'ls-remote', '--heads', this.gitTarget(binding.repo,binding.remoteUrl).url, `refs/heads/${binding.branch}`], undefined, env, input.assertAuthorized, input.signal)
        const remoteHead = remote.split(/\s+/)[0] || undefined
        if (remoteHead && remoteHead !== binding.commitId) throw new Error('远端分支已有不同提交，不能覆盖')
        if (!remoteHead) {
          input.assertAuthorized?.()
          await this.git([`--git-dir=${binding.gitDir}`, 'push', '--quiet', this.gitTarget(binding.repo,binding.remoteUrl).url, `${binding.commitId}:refs/heads/${binding.branch}`], undefined, env, input.assertAuthorized, input.signal)
        }
        this.update(binding.id, { state: 'pushed' })
        binding = this.binding(binding.dir)!
      }
      if (!(this.opts.createPullRequests ?? binding.remoteUrl.startsWith('https://'))) {
        const result: ChangeResult = { url: '', number: 0, branch: binding.branch, base: binding.base, repo: binding.repo, files: summary.files, head: binding.commitId!, phase: 'pushed' }
        this.update(binding.id, { state: 'confirmed', result: JSON.stringify(result) })
        return result
      }
      if (binding.prNumber) return this.readPr(binding, binding.prNumber, summary.files, input)
      const existing = await this.findPr(binding, input)
      if (existing) {
        this.update(binding.id, { state: 'pr_sent', pr_number: existing })
        return this.readPr(binding, existing, summary.files, input)
      }
      if (binding.state !== 'pushed') throw new Error(UNKNOWN_PR)
      // pushed 可能来自上次调用；等待/重启期间远端分支不能被换成未经此次确认的提交。
      const currentRef = await this.git([`--git-dir=${binding.gitDir}`, 'ls-remote', '--heads', this.gitTarget(binding.repo,binding.remoteUrl).url, `refs/heads/${binding.branch}`], undefined, await this.authEnv(binding.repo,input.signal,binding.remoteUrl), input.assertAuthorized, input.signal)
      if (currentRef.split(/\s+/)[0] !== binding.commitId) throw new Error('远端分支已在推送后变化，须核对后再创建 PR')
      input.assertAuthorized?.()
      const claimed = this.opts.db.prepare("UPDATE github_changes SET state = 'pr_planned', updated_at = ? WHERE id = ? AND state = 'pushed'").run(this.now(), binding.id)
      if (!Number(claimed.changes)) throw new Error(UNKNOWN_PR)
      let number: number
      let requestStarted = !input.assertAuthorized
      const beforeRequest = (): void => { input.assertAuthorized?.(); requestStarted = true }
      try {
        const pr = await this.opts.github.api<{ html_url?: string; number?: number }>('POST', `/repos/${binding.repo}/pulls`, { title, body: input.body.trim(), head: binding.branch, base: binding.base, draft: true }, binding.repo.split('/')[0], beforeRequest, input.signal)
        requestStarted = true
        number = Number(pr.number)
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error('创建 PR 没有返回编号')
        this.update(binding.id, { state: 'pr_sent', pr_number: number, pr_url: pr.html_url ?? null })
      } catch (err) {
        if (!requestStarted) {
          this.opts.db.prepare("UPDATE github_changes SET state = 'pushed', updated_at = ? WHERE id = ? AND state = 'pr_planned'").run(this.now(), binding.id)
          throw err
        }
        try { this.update(binding.id, { state: 'pr_unknown', error: String(err).slice(0, 500) }) } catch { /* pr_planned 也禁止重发 */ }
        throw new Error(UNKNOWN_PR, { cause: err })
      }
      return this.readPr(binding, number, summary.files, input)
    })
  }
}
function waitForPreparation<T>(operation: Promise<T>, signal?: AbortSignal, waitForOwner?: () => boolean): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (waitForOwner?.()) return // the active Git owner settles only after process exit and credential cleanup
      cleanup(); reject(signal.reason ?? new Error('副本准备请求已取消'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}
function classifyGitFailure(stderr: string): string {
  if (/Authentication failed|could not read Username|401|403|Repository not found/i.test(stderr)) return 'authentication_or_access'
  if (/proxy|CONNECT/i.test(stderr)) return 'proxy'
  if (/SSL|certificate/i.test(stderr)) return 'tls'
  if (/resolve host/i.test(stderr)) return 'dns'
  if (/connect|timed out/i.test(stderr)) return 'network'
  return 'git_failed'
}
function inside(root: string, path: string): boolean { return path.startsWith(root + sep) }
function parseTreeDiff(raw: string): StagedOutputEntry[] {
  const parts = raw.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2) throw new ChangeAccessError('执行结果的 tree 差异无法解析')
  const entries: StagedOutputEntry[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/.exec(parts[index]!)
    if (!header) throw new ChangeAccessError('执行结果的 tree 差异无法解析')
    entries.push({ path: parts[index + 1]!, status: header[5]!, srcMode: header[1]!, dstMode: header[2]!, srcBlob: header[3]!, dstBlob: header[4]! })
  }
  return entries
}
function gitConfigValue(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"` }
function matchesPr(pr: Record<string, unknown>, binding: ChangeBinding): boolean {
  const head = pr.head as { sha?: string } | undefined
  return matchesPrBranch(pr, binding) && head?.sha === binding.commitId
}
/** GitHub preserves account/repository display casing; Git refs remain exact. */
function sameRepository(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()
}
function matchesPrBranch(pr: Record<string, unknown>, binding: ChangeBinding): boolean {
  const head = pr.head as { ref?: string; sha?: string; repo?: { full_name?: string } } | undefined
  const base = pr.base as { ref?: string; repo?: { full_name?: string } } | undefined
  return head?.ref === binding.branch && sameRepository(head.repo?.full_name, binding.repo) &&
    base?.ref === binding.base && sameRepository(base.repo?.full_name, binding.repo)
}
function toBinding(r: Record<string, unknown>): ChangeBinding {
  return {
    id: String(r.id), sessionKey: String(r.session_key), requesterOpenId: String(r.requester_open_id), cwd: String(r.cwd), dir: String(r.dir),
    originWorkKey: r.origin_work_key == null ? null : String(r.origin_work_key),
    repo: String(r.repo), base: String(r.base), baseCommit: String(r.base_commit), branch: String(r.branch), remoteUrl: String(r.remote_url), gitDir: String(r.git_dir),
    state: String(r.state), snapshot: r.snapshot as string | null, publishIntent: r.publish_intent as string | null, commitId: r.commit_id as string | null,
    prNumber: r.pr_number == null ? null : Number(r.pr_number), prUrl: r.pr_url as string | null, result: r.result ? JSON.parse(String(r.result)) as ChangeResult : null, createdAt: Number(r.created_at),
  }
}
function toChangeUpdate(r: Record<string, unknown>): ChangeUpdate {
  return { id: String(r.id), parentCommit: String(r.parent_commit), snapshot: String(r.snapshot), intent: String(r.intent),
    commitId: String(r.commit_id), state: String(r.state), result: r.result ? JSON.parse(String(r.result)) as ChangeResult : null }
}
