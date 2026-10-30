import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity, loadGitHubConfig } from '../src/github/identity.js'
import { RepositoryFiles } from '../src/github/repository-files.js'
import { createLogger } from '../src/log.js'
import { ExecutorClientError, type ExecutorJobInput, type ExecutorJobReceipt } from '../src/github/executor-client.js'
import { RepositoryExecutionError, RepositoryExecutions, RepositoryExecutionSnapshotChanged, ensureGitHubExecutionSchema,
  type RepositoryExecutionDeps, type RepositoryExecutionIdentity, type RepositoryExecutionSnapshot } from '../src/github/executions.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const INITIAL = 'a'.repeat(40)
const START = { changeId: 'change-original', expectedSnapshot: INITIAL, command: 'npm test', timeoutMs: 60_000 }
const SNAPSHOT = { repo: 'org/demo', baseSha: 'b'.repeat(40), inputTree: 'c'.repeat(40), patch: 'synthetic patch bytes: do not persist' }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function queued(id: string, input: ExecutorJobInput): ExecutorJobReceipt {
  return { version: 1, id, digest: hash(input), state: 'queued', outcome: null, createdAt: 100,
    startedAt: null, finishedAt: null, deadline: null, cleanup: 'not_started', result: null }
}
function finish(receipt: ExecutorJobReceipt, overrides: Partial<ExecutorJobReceipt> = {}): ExecutorJobReceipt {
  return { ...receipt, state: 'finished', outcome: 'passed', startedAt: 110, deadline: 60_110, finishedAt: 120,
    cleanup: 'confirmed', result: { status: 'passed', beforeTree: SNAPSHOT.inputTree, afterTree: SNAPSHOT.inputTree,
      exitCode: 0, runtime: 'node20', phase: 'command', output: { stdout: 'synthetic tests passed', stderr: '', truncated: false } }, ...overrides }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-executions-')), filename = join(home, 'ledger.sqlite')
  let db = new DatabaseSync(filename), time = 1000, authorized = true, source = true, currentSnapshot = INITIAL
  const snapshot: RepositoryExecutionSnapshot = { ...SNAPSHOT }
  const receipts = new Map<string, ExecutorJobReceipt>()
  const calls: { method: string; id: string; input?: ExecutorJobInput }[] = []
  const snapshotCalls: { identity: RepositoryExecutionIdentity; input: { changeId: string; expectedSnapshot: string } }[] = []
  const deps: RepositoryExecutionDeps = {
    get db() { return db }, now: () => time++,
    async snapshot(identity, input) {
      identity.assertAuthorized(); snapshotCalls.push({ identity, input })
      if (input.changeId !== START.changeId) throw new Error('change not available')
      if (input.expectedSnapshot !== currentSnapshot) throw new RepositoryExecutionSnapshotChanged()
      return { ...snapshot }
    },
    authorize(identity, repo) {
      const assert = () => { identity.assertAuthorized(); if (!source || repo !== 'org/demo') throw new Error('source permission revoked') }
      assert(); return assert
    },
    client: {
      async submit(id, input, guard) {
        guard(); calls.push({ method: 'POST', id, input: { ...input } })
        // The real SQLite claim must exist before any provider request begins.
        const row = db.prepare('SELECT id,digest,submission_status FROM github_executions WHERE id=?').get(id)
        expect(row).toMatchObject({ id, digest: hash(input), submission_status: 'claimed' })
        const receipt = queued(id, input); receipts.set(id, receipt); return structuredClone(receipt)
      },
      async read(id, guard) {
        guard(); calls.push({ method: 'GET', id })
        const receipt = receipts.get(id)
        if (!receipt) throw new ExecutorClientError('not_found', 'read', 'read_failed', 404)
        return structuredClone(receipt)
      },
      async stop(id, guard) {
        guard(); calls.push({ method: 'STOP', id })
        const prior = receipts.get(id)
        const receipt: ExecutorJobReceipt = { ...(prior ?? queued(id, { ...SNAPSHOT, command: START.command, timeoutMs: START.timeoutMs })),
          digest: prior?.digest ?? null, state: 'finished', outcome: 'cancelled', cleanup: 'confirmed', result: null, finishedAt: 130 }
        receipts.set(id, receipt); return structuredClone(receipt)
      },
    },
  }
  const identity: RepositoryExecutionIdentity = { cwd: '/private/host/checkout-do-not-persist', sessionKey: 'session-original',
    requesterOpenId: 'alice', workKey: 'task:1', taskId: 1, runId: 'run-original',
    assertAuthorized() { if (!authorized) throw new Error('original Work or Run stopped') } }
  const application = new RepositoryExecutions(deps)
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }) })
  return { application, deps, identity, snapshot, snapshotCalls, receipts, calls,
    get db() { return db },
    reopen() { db.close(); db = new DatabaseSync(filename); return new RepositoryExecutions(deps) },
    revoke: () => { authorized = false }, revokeSource: () => { source = false },
    changeTree() { currentSnapshot = 'd'.repeat(40); snapshot.inputTree = 'e'.repeat(40) },
    latestId: () => String(db.prepare('SELECT id FROM github_executions ORDER BY created_at DESC LIMIT 1').get()!.id),
  }
}

describe('RepositoryExecutions persistent provider-operation boundary', () => {
  it('accepts the actual ChangeManager Git-tree snapshot after a real broker edit and exports that exact tree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'friday-execution-git-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
    const seed = join(root, 'seed'), bare = join(root, 'remote.git'), cwd = join(root, 'workspace')
    mkdirSync(seed); git(seed, 'init', '-q'); git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    writeFileSync(join(seed, 'README.md'), '# Demo\n'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'initial')
    git(root, 'clone', '-q', '--bare', seed, bare)
    const registry = new Registry(':memory:'); cleanups.push(() => registry.close())
    registry.createSession({ sessionKey: 'session', requesterOpenId: 'owner', chatId: 'chat', chatType: 'p2p', cwd })
    const task = registry.createTask({ sessionKey: 'session', requesterOpenId: 'owner', messageId: 'message', prompt: 'Edit and test this change' })
    const identity: RepositoryExecutionIdentity = { cwd, sessionKey: 'session', requesterOpenId: 'owner', taskId: task.id,
      workKey: registry.taskWork.get(task.id)!.key, runId: 'real-input-run', assertAuthorized() {} }
    const log = createLogger('test', 'error')
    const github = new GitHubIdentity(loadGitHubConfig({ GITHUB_TOKEN: 'fixture-token', FRIDAY_GITHUB_REPOS: 'org/demo',
      FRIDAY_GITHUB_WRITE_REPOS: 'org/demo' })!, log, { async request() { throw new Error('No GitHub request expected') } })
    const changes = new ChangeManager({ db: registry.db, github, cacheDir: join(root, 'cache'), log, remoteUrlFor: () => `file://${bare}` })
    const prepared = await changes.prepare({ ...identity, repo: 'org/demo' })
    const files = new RepositoryFiles({ changes, async authorize() { return { assertCurrent: identity.assertAuthorized } }, recordRead() {} })
    const read = await files.read(identity, { changeId: prepared.id, path: 'README.md' })
    const written = await files.write(identity, { changeId: prepared.id, path: 'README.md', expectedSnapshot: read.snapshot,
      expectedDigest: read.digest, content: '# Demo\n\nChanged before execution.\n' })
    expect(written.snapshot).toMatch(/^[a-f0-9]{40}$/)
    const inputs: ExecutorJobInput[] = []
    const executions = new RepositoryExecutions({ db: registry.db,
      snapshot: (actor, input) => changes.executionSnapshot({ ...actor, ...input }),
      authorize: actor => actor.assertAuthorized,
      client: {
        async submit(id, input, guard) { guard(); inputs.push(input); return queued(id, input) },
        async read() { throw new Error('Unexpected read') }, async stop() { throw new Error('Unexpected stop') },
      } })
    const result = await executions.start(identity, { changeId: prepared.id, expectedSnapshot: written.snapshot, command: 'npm test', timeoutMs: 60_000 })
    expect(result).toMatchObject({ state: 'active', inputSnapshot: written.snapshot, inputTree: written.snapshot })
    expect(inputs).toHaveLength(1)
    const replica = join(root, 'replica'); git(root, 'clone', '-q', bare, replica)
    git(replica, 'checkout', '--detach', inputs[0]!.baseSha)
    const patch = join(root, 'change.patch'); writeFileSync(patch, inputs[0]!.patch)
    git(replica, 'apply', '--index', '--binary', patch)
    expect(git(replica, 'write-tree')).toBe(written.snapshot)
    expect(inputs[0]!.patch).not.toContain('.friday-change.json')
    await expect(executions.start(identity, { ...START, changeId: prepared.id, expectedSnapshot: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(inputs).toHaveLength(1)
  })

  it('claims the exact input before POST, stores no patch/path, and projects a verified result for the current tree', async () => {
    const t = fixture(), created = await t.application.start(t.identity, START)
    expect(created).toMatchObject({ changeId: START.changeId, repo: 'org/demo', state: 'active', validation: 'pending' })
    expect(t.calls).toHaveLength(1)
    const stored = t.db.prepare('SELECT * FROM github_executions').get()!
    expect(stored).toMatchObject({ task_id: 1, origin_run_id: 'run-original', work_key: 'task:1',
      input_snapshot: INITIAL, input_tree: SNAPSHOT.inputTree, digest: hash(t.calls[0]!.input) })
    expect(JSON.stringify(stored)).not.toContain(SNAPSHOT.patch)
    expect(JSON.stringify(stored)).not.toContain(t.identity.cwd)
    expect(Object.keys(stored)).not.toContain('patch')
    t.receipts.set(created.id, finish(t.receipts.get(created.id)!))
    const done = await t.application.read(t.identity, { id: created.id, changeId: START.changeId })
    expect(done).toMatchObject({ state: 'finished', validation: 'passed', snapshotCurrent: 'current', receipt: { cleanup: 'confirmed' } })
  })

  it('same Task and a new Run use the original job; a real new Task in the same Work may request a new test', async () => {
    const t = fixture(), first = await t.application.start(t.identity, START)
    const duplicate = await t.application.start(t.identity, START)
    const resumed = await t.application.start({ ...t.identity, runId: 'resumed-real-run' }, START)
    expect(duplicate.id).toBe(first.id); expect(resumed.id).toBe(first.id)
    expect(t.calls.map(call => call.method)).toEqual(['POST', 'GET', 'GET'])
    const amended = await t.application.start({ ...t.identity, taskId: 2, runId: 'amendment-real-run' }, START)
    expect(amended.id).not.toBe(first.id)
    expect(t.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  })

  it('links each authorized call to the durable operation before any provider request, including reuse and stop', async () => {
    const t = fixture(), observations: { id: string; calls: number; status: string | undefined }[] = []
    t.identity.onExecution = id => {
      expect(t.db.prepare('SELECT id FROM github_executions WHERE id=?').get(id)?.id).toBe(id)
      observations.push({ id, calls: t.calls.length, status: t.application.operationStatus(id) })
    }
    const first = await t.application.start(t.identity, START)
    await t.application.start(t.identity, START)
    await t.application.read(t.identity, { id: first.id, changeId: START.changeId })
    await t.application.stop(t.identity, { id: first.id, changeId: START.changeId })
    expect(observations).toEqual([0, 1, 2, 3].map(calls => ({ id: first.id, calls, status: 'unresolved' })))
    expect(t.application.operationStatus(first.id)).toBe('cancelled')
    await expect(t.application.read({ ...t.identity, workKey: 'another-work' }, { id: first.id, changeId: START.changeId }))
      .rejects.toMatchObject({ code: 'scope_mismatch' })
    expect(observations).toHaveLength(4)
  })

  it('a failed host receipt link never starts the external job', async () => {
    const t = fixture()
    t.identity.onExecution = () => { throw new Error('original host call no longer open') }
    await expect(t.application.start(t.identity, START)).rejects.toThrow('no longer open')
    expect(t.calls).toEqual([])
    expect(t.application.operationStatus(t.latestId())).toBe('unresolved')
  })

  it('projects historical operation facts without claiming a changed current tree has passed', async () => {
    const t = fixture(), pending = await t.application.start(t.identity, START)
    expect(t.application.operationStatus('missing')).toBeUndefined()
    expect(t.application.operationStatus(pending.id)).toBe('unresolved')
    t.receipts.set(pending.id, finish(pending.receipt!))
    const passed = await t.application.read(t.identity, { id: pending.id, changeId: START.changeId })
    expect(passed.validation).toBe('passed')
    expect(t.application.operationStatus(pending.id)).toBe('succeeded')
    t.changeTree()
    const restored = t.reopen()
    const stale = await restored.read(t.identity, { id: pending.id, changeId: START.changeId })
    expect(stale.validation).toBe('stale')
    expect(restored.operationStatus(pending.id)).toBe('succeeded')
  })

  it('an unknown submission survives SQLite reopen and can be confirmed only by reading the same job', async () => {
    const t = fixture(), submit = t.deps.client.submit
    t.deps.client.submit = async (...args) => { await submit(...args); throw new ExecutorClientError('network_error', 'submit', 'unknown') }
    const pending = await t.application.start(t.identity, START)
    expect(pending).toMatchObject({ state: 'unknown', validation: 'unknown', errorCode: 'network_error', receipt: null })
    t.receipts.set(pending.id, finish(t.receipts.get(pending.id)!))
    const restored = t.reopen()
    const recovered = await restored.start({ ...t.identity, runId: 'after-restart' }, START)
    expect(recovered).toMatchObject({ id: pending.id, state: 'finished', validation: 'passed' })
    expect(t.calls.map(call => call.method)).toEqual(['POST', 'GET'])
  })

  it('a crash-like claimed row and later 404 never cause another submit or a fabricated failed result', async () => {
    const t = fixture(), submit = deferred<ExecutorJobReceipt>(), entered = deferred()
    t.deps.client.submit = async () => { entered.resolve(); return submit.promise }
    const first = t.application.start(t.identity, START)
    await entered.promise
    const secondInstance = new RepositoryExecutions(t.deps)
    const pending = await secondInstance.start({ ...t.identity, runId: 'another-run' }, START)
    expect(pending).toMatchObject({ state: 'unknown', errorCode: 'not_found', validation: 'unknown' })
    expect(t.calls).toEqual([{ method: 'GET', id: pending.id }])
    submit.resolve(queued(pending.id, { ...SNAPSHOT, command: START.command, timeoutMs: START.timeoutMs }))
    expect((await first).state).toBe('active')
    expect(t.db.prepare('SELECT count(*) AS n FROM github_executions').get()?.n).toBe(1)
  })

  it('two concurrent starts claim one operation across class instances', async () => {
    const t = fixture(), release = deferred(), entered = deferred(), submit = t.deps.client.submit
    t.deps.client.submit = async (...args) => { const receipt = await submit(...args); entered.resolve(); await release.promise; return receipt }
    const first = t.application.start(t.identity, START); await entered.promise
    const second = await new RepositoryExecutions(t.deps).start(t.identity, START)
    release.resolve()
    expect((await first).id).toBe(second.id)
    expect(t.calls.map(call => call.method)).toEqual(['POST', 'GET'])
  })

  it.each(['actor', 'session', 'work', 'change'] as const)('refuses cross-%s read and stop without contacting the provider', async field => {
    const t = fixture(), job = await t.application.start(t.identity, START), before = t.calls.length
    const identity = { ...t.identity, ...(field === 'actor' ? { requesterOpenId: 'bob' } : field === 'session' ? { sessionKey: 'another' }
      : field === 'work' ? { workKey: 'task:2' } : {}) }
    const ref = { id: job.id, changeId: field === 'change' ? 'other-change' : START.changeId }
    for (const action of ['read', 'stop'] as const) await expect(t.application[action](identity, ref)).rejects.toMatchObject({ code: 'scope_mismatch' })
    expect(t.calls).toHaveLength(before)
  })

  it('marks a genuinely changed checkout stale while retaining the provider result, even after restart', async () => {
    const t = fixture(), job = await t.application.start(t.identity, START)
    t.receipts.set(job.id, finish(t.receipts.get(job.id)!)); t.changeTree()
    const view = await t.reopen().read(t.identity, { id: job.id, changeId: START.changeId })
    expect(view).toMatchObject({ state: 'finished', validation: 'stale', snapshotCurrent: 'stale', receipt: { outcome: 'passed' } })
    expect(t.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not turn unrelated Git IO or source permission failures into a stale-tree result', async () => {
    const t = fixture(), job = await t.application.start(t.identity, START)
    t.deps.snapshot = async () => { throw new Error('fixture filesystem unavailable') }
    await expect(t.application.read(t.identity, { id: job.id, changeId: START.changeId })).rejects.toThrow('filesystem unavailable')
    t.revokeSource(); const count = t.calls.length
    await expect(t.application.read(t.identity, { id: job.id, changeId: START.changeId })).rejects.toThrow('permission revoked')
    expect(t.calls).toHaveLength(count)
  })

  it.each(['unfinished', 'cleanup', 'wrong_before', 'wrong_after', 'truncated', 'nonzero', 'output_limit'] as const)(
    'does not declare passed for %s evidence', async variant => {
      const t = fixture(), job = await t.application.start(t.identity, START), receipt = finish(t.receipts.get(job.id)!)
      if (variant === 'unfinished') { receipt.state = 'stopping'; receipt.finishedAt = null; receipt.cleanup = 'pending' }
      if (variant === 'cleanup') receipt.cleanup = 'pending'
      if (variant === 'wrong_before') receipt.result!.beforeTree = 'f'.repeat(40)
      if (variant === 'wrong_after') receipt.result!.afterTree = 'f'.repeat(40)
      if (variant === 'truncated') receipt.result!.output.truncated = true
      if (variant === 'nonzero') receipt.result!.exitCode = 1
      if (variant === 'output_limit') { receipt.outcome = 'output_limit'; receipt.result!.status = 'output_limit'; receipt.result!.output.truncated = true }
      t.receipts.set(job.id, receipt)
      const view = await t.application.read(t.identity, { id: job.id, changeId: START.changeId })
      expect(view.validation).not.toBe('passed')
      expect(t.application.operationStatus(job.id)).toBe(variant === 'unfinished' || variant === 'cleanup' ? 'unresolved' : 'failed')
    })

  it('rejects a mismatching id or digest and preserves the previous genuine provider receipt', async () => {
    const t = fixture(), job = await t.application.start(t.identity, START), before = job.receipt
    for (const changed of [{ digest: 'f'.repeat(64) }, { id: 'unrelated-job-1234567890' }]) {
      t.deps.client.read = async () => ({ ...finish(before!), ...changed })
      await expect(t.application.read(t.identity, { id: job.id, changeId: START.changeId })).rejects.toMatchObject({ code: 'provider_invalid_receipt' })
      expect(JSON.parse(String(t.db.prepare('SELECT receipt_json FROM github_executions').get()!.receipt_json))).toEqual(before)
    }
  })

  it('stops only this provider job, including a changed checkout, and retains its actual cancelled receipt', async () => {
    const t = fixture(), job = await t.application.start(t.identity, START)
    t.changeTree()
    const before = { ...t.identity }
    const result = await t.application.stop(t.identity, { id: job.id, changeId: START.changeId })
    expect(result).toMatchObject({ state: 'finished', validation: 'not_passed', stopRequested: true,
      receipt: { outcome: 'cancelled', cleanup: 'confirmed' } })
    expect(t.identity).toEqual(before)
    expect(t.calls.map(call => call.method)).toEqual(['POST', 'STOP'])
    expect(t.snapshotCalls).toHaveLength(2)
  })

  it('an unknown stop keeps its intent after restart; GET can verify the same permanent tombstone', async () => {
    const t = fixture()
    t.deps.client.submit = async () => { throw new ExecutorClientError('timeout', 'submit', 'unknown') }
    const job = await t.application.start(t.identity, START), stop = t.deps.client.stop
    t.deps.client.stop = async (...args) => { await stop(...args); throw new ExecutorClientError('timeout', 'stop', 'unknown') }
    const unknown = await t.application.stop(t.identity, { id: job.id, changeId: START.changeId })
    expect(unknown).toMatchObject({ state: 'stopping', stopRequested: true, receipt: null, errorCode: 'timeout' })
    const restored = await t.reopen().read(t.identity, { id: job.id, changeId: START.changeId })
    expect(restored).toMatchObject({ state: 'finished', validation: 'not_run', stopRequested: true,
      receipt: { digest: null, outcome: 'cancelled', startedAt: null, deadline: null, result: null } })
    expect(t.calls.map(call => call.method)).toEqual(['STOP', 'GET'])
  })

  it('rejects digest-null receipts which do not prove the exact pre-submission stop tombstone', async () => {
    const t = fixture(), job = await t.application.start(t.identity, START)
    t.deps.client.read = async () => ({ ...finish(job.receipt!), digest: null, outcome: 'cancelled', result: null })
    await expect(t.application.read(t.identity, { id: job.id, changeId: START.changeId })).rejects.toMatchObject({ code: 'provider_invalid_receipt' })
  })

  it('keeps an ACK received after local stop/revocation, but does not return it as renewed permission', async () => {
    const t = fixture(), submit = t.deps.client.submit
    t.deps.client.submit = async (...args) => { const receipt = await submit(...args); t.revoke(); return receipt }
    await expect(t.application.start(t.identity, START)).rejects.toThrow('stopped')
    const row = t.db.prepare('SELECT submission_status,receipt_json FROM github_executions').get()!
    expect(row.submission_status).toBe('accepted')
    expect(JSON.parse(String(row.receipt_json))).toMatchObject({ state: 'queued' })
    expect(t.snapshotCalls).toHaveLength(1)
  })

  it('late submit/read receipts cannot overwrite a separately confirmed stop', async () => {
    const t = fixture(), release = deferred(), entered = deferred(), submit = t.deps.client.submit
    t.deps.client.submit = async (...args) => { const receipt = await submit(...args); entered.resolve(); await release.promise; return receipt }
    const starting = t.application.start(t.identity, START); await entered.promise
    const id = t.latestId(), other = new RepositoryExecutions(t.deps)
    const stopped = await other.stop(t.identity, { id, changeId: START.changeId })
    expect(stopped.receipt?.outcome).toBe('cancelled')
    release.resolve()
    expect(await starting).toMatchObject({ id, state: 'finished', receipt: { outcome: 'cancelled' } })
  })

  it('checks source authorization again after asynchronous snapshot and before admitting an operation', async () => {
    const t = fixture(), snapshot = t.deps.snapshot
    t.deps.snapshot = async (...args) => { const result = await snapshot(...args); t.revoke(); return result }
    await expect(t.application.start(t.identity, START)).rejects.toThrow('stopped')
    expect(t.calls).toEqual([])
    expect(t.db.prepare('SELECT count(*) AS n FROM github_executions').get()?.n).toBe(0)
  })

  it('stores a typed rejection, never copies raw errors, and does not blindly resubmit it', async () => {
    const t = fixture()
    t.deps.client.submit = async () => { throw new ExecutorClientError('forbidden', 'submit', 'rejected', 403) }
    expect(await t.application.start(t.identity, START)).toMatchObject({ state: 'rejected', validation: 'not_run', errorCode: 'forbidden' })
    const retry = await t.application.start(t.identity, START)
    expect(retry).toMatchObject({ state: 'rejected', errorCode: 'not_found' })
    expect(t.calls.map(call => call.method)).toEqual(['GET'])
    const other = fixture()
    other.deps.client.submit = async () => { throw new Error('secret=do-not-copy; /host/private/path') }
    await expect(other.application.start(other.identity, START)).rejects.toBeInstanceOf(RepositoryExecutionError)
    expect(JSON.stringify(other.db.prepare('SELECT * FROM github_executions').get())).not.toContain('do-not-copy')
    expect(other.db.prepare('SELECT submission_status FROM github_executions').get()?.submission_status).toBe('unknown')
  })

  it('schema-only initialization is idempotent and never touches existing rows or provider calls', async () => {
    const t = fixture(); await t.application.start(t.identity, START)
    const before = t.db.prepare('SELECT * FROM github_executions').all()
    ensureGitHubExecutionSchema(t.db); ensureGitHubExecutionSchema(t.db)
    expect(t.db.prepare('SELECT * FROM github_executions').all()).toEqual(before)
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'github_executions' }])
    expect(t.calls).toHaveLength(1)
  })
})
