import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry } from '../src/core/registry.js'
import { ChangeManager, ChangeSnapshotError } from '../src/github/changes.js'
import { GitHubIdentity, type GitHubHttp } from '../src/github/identity.js'
import { RepositoryFiles } from '../src/github/repository-files.js'
import { createLogger } from '../src/log.js'
import { ExecutorClient, ExecutorClientError, type ExecutorJobReceipt, type ExecutorTransportRequest } from '../src/github/executor-client.js'
import { RepositoryExecutionError, RepositoryExecutionImportPending, RepositoryExecutionSnapshotChanged, RepositoryExecutions,
  ensureGitHubExecutionSchema, type RepositoryExecutionView } from '../src/github/executions.js'
import { RepositoryExecutionOutputs, type RepositoryExecutionOutputIdentity } from '../src/github/execution-output.js'
import { GENERATED, PROVIDER_SECRET as SECRET, startExecutorProvider } from './helpers/executor-provider.js'

const log = createLogger('test', 'error')
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  } }).trim()
}
const BEFORE = GENERATED.before, AFTER = GENERATED.after

/** Real Git change + ChangeManager + provider HTTP service (node:sqlite) + the
 * rootless runner with a subprocess Docker CLI fixture. The container "runs" the
 * command by editing its bind-mounted worktree; nothing else is simulated. */
async function fixture(options: { afterFile?: (index: number, path: string) => void } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'friday-execution-output-')))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const src = join(home, 'src'), bare = join(home, 'remote.git'), cwd = join(home, 'workspace'), dbPath = join(home, 'registry.db')
  mkdirSync(join(src, 'docs'), { recursive: true })
  git(src, 'init', '-q'); git(src, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(src, 'README.md'), 'original\n')
  writeFileSync(join(src, 'docs', 'a.i18n.yaml'), BEFORE.a); writeFileSync(join(src, 'docs', 'b.i18n.yaml'), BEFORE.b)
  writeFileSync(join(src, 'docs', 'guide.md'), '# Guide\n')
  git(src, 'add', '-A'); git(src, 'commit', '-qm', 'initial')
  git(home, 'clone', '--quiet', '--bare', src, bare)
  const baseSha = git(bare, 'rev-parse', 'main')

  // Gateway: Registry, real Task/Work, GitHub PR API replaced by a local fake; git remote is the bare.
  let registry = new Registry(dbPath)
  cleanups.push(() => registry.close())
  registry.createSession({ sessionKey: 'session', requesterOpenId: 'owner', chatId: 'chat', chatType: 'p2p', cwd })
  const task = registry.createTask({ sessionKey: 'session', requesterOpenId: 'owner', messageId: 'message', prompt: 'Regenerate the translation record' })
  const workKey = registry.taskWork.get(task.id)!.key
  const calls: { method: string; path: string }[] = []
  let branch = '', number = 0
  const pr = () => ({ number, html_url: `https://github.com/org/demo/pull/${number}`, state: 'open', merged: false, draft: true,
    head: { ref: branch, sha: git(bare, 'rev-parse', branch), repo: { full_name: 'org/demo' } }, base: { ref: 'main', repo: { full_name: 'org/demo' } } })
  const http = { async request(method: string, path: string, body?: Record<string, unknown>) {
    calls.push({ method, path })
    if (path.includes('/pulls?')) return { status: 200, data: number ? [pr()] : [] }
    if (method === 'POST' && path.endsWith('/pulls')) { branch = String(body!.head); number++; return { status: 201, data: pr() } }
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return { status: 200, data: pr() }
    throw new Error(`Unexpected HTTP ${method} ${path}`)
  } } as GitHubHttp
  const github = new GitHubIdentity({ apiUrl: 'https://api.github.com', mode: 'pat', token: 'synthetic-only', allowedRepos: ['org/demo'],
    writableRepos: ['org/demo'] }, log, http)
  const cacheDir = join(home, 'gateway-git')
  const newChanges = () => new ChangeManager({ db: registry.db, cacheDir, github, log, remoteUrlFor: () => `file://${bare}`,
    createPullRequests: true, author: { name: 'Friday', email: 'friday@example.test' } })
  let changes = newChanges()
  const state = { authorized: true, writeAllowed: true, repoAllowed: true }
  const fileWrites: { path: string; expectedDigest: string | null | undefined; contentDigest: string | null | undefined }[] = []
  const identity: RepositoryExecutionOutputIdentity = { cwd, sessionKey: 'session', requesterOpenId: 'owner', workKey, taskId: task.id, runId: 'run-1',
    assertAuthorized() { if (!state.authorized) throw new Error('original Work stopped') },
    async authorizeFileWrite(access) {
      fileWrites.push({ path: access.path, expectedDigest: access.expectedDigest, contentDigest: access.contentDigest })
      const assertCurrent = () => { if (!state.writeAllowed) throw new Error('repository write permission revoked') }
      assertCurrent(); return { assertCurrent }
    } }
  const prepared = await changes.prepare({ ...identity, repo: 'org/demo' })
  writeFileSync(join(prepared.dir, 'docs', 'guide.md'), '# Guide\n\nFirst fix.\n')
  const inspected = await changes.inspect({ ...identity, dir: prepared.dir })
  const initial = await changes.publish({ ...identity, dir: prepared.dir, expectedSnapshot: inspected.snapshot, title: 'Fix guide', body: 'Initial PR' })

  // Provider: bundle for the base commit, SQLite receipts, rootless runner with the CLI fixture.
  const provider = await startExecutorProvider({ root: join(home, 'provider'), bare, baseSha })
  cleanups.push(() => provider.close())
  const { client, sent, hooks, artifacts } = provider
  const newExecutions = () => new RepositoryExecutions({ db: registry.db, client,
    snapshot: async (actor, input) => {
      try { return await changes.executionSnapshot({ ...actor, ...input }) }
      catch (error) { if (error instanceof ChangeSnapshotError) throw new RepositoryExecutionSnapshotChanged(); throw error }
    },
    authorize: (actor, repo) => () => { actor.assertAuthorized(); if (!state.repoAllowed || repo !== 'org/demo') throw new Error('repository access revoked') } })
  let executions = newExecutions()
  const outputRoot = join(cacheDir, 'execution-output')
  const newOutputs = (afterFile?: (index: number, path: string) => void) => new RepositoryExecutionOutputs({ executions, client, changes, outputRoot, afterFile })
  let outputs = newOutputs(options.afterFile)
  const f = {
    home, bare, cwd, prepared, initial, identity, state, calls, sent, hooks, fileWrites, outputRoot, artifacts, baseSha,
    get files() { return new RepositoryFiles({ changes, async authorize() { return { assertCurrent: () => {} } }, recordRead() {} }) },
    get changes() { return changes }, get executions() { return executions }, get outputs() { return outputs }, get registry() { return registry },
    text: (path: string) => readFileSync(join(prepared.dir, path), 'utf8'),
    exists: (path: string) => existsSync(join(prepared.dir, path)),
    snapshot: async () => (await changes.inspect({ ...identity, dir: prepared.dir })).snapshot,
    row: (id: string) => registry.db.prepare('SELECT * FROM github_executions WHERE id=?').get(id) as Record<string, unknown>,
    async wait(id: string): Promise<RepositoryExecutionView> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const view = await executions.read(identity, { id, changeId: prepared.id })
        if (view.state === 'finished') return view
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('execution did not finish')
    },
    async generate(paths = ['docs'], maxBytes?: number) {
      const expectedSnapshot = await f.snapshot()
      const started = await executions.start(identity, { changeId: prepared.id, expectedSnapshot, command: 'generate', timeoutMs: 20_000,
        capture: { paths, ...(maxBytes === undefined ? {} : { maxBytes }) } })
      const view = await f.wait(started.id)
      return { id: started.id, expectedSnapshot, view }
    },
    apply(run: { id: string; expectedSnapshot: string; view: RepositoryExecutionView }, overrides: Partial<{ artifactDigest: string; expectedSnapshot: string }> = {}) {
      return outputs.applyOutput(identity, { executionId: run.id, changeId: prepared.id, expectedSnapshot: run.expectedSnapshot,
        artifactDigest: run.view.output!.artifact!.digest, ...overrides })
    },
    downloads: () => sent.filter(request => request.url.endsWith('/output')).length,
    /** A fresh gateway process: new DB handle and all domain objects rebuilt from durable state. */
    reopen(afterFile?: (index: number, path: string) => void) {
      registry.close(); registry = new Registry(dbPath)
      changes = newChanges(); executions = newExecutions(); outputs = newOutputs(afterFile)
    },
  }
  return f
}

describe('protocol 2 generator output: export, bounded download, CAS import, re-validation, same-PR update', () => {
  it('imports two modified files and one new file, validates the new tree and appends one commit to the same PR', async () => {
    const f = await fixture()
    const run = await f.generate()
    expect(run.view).toMatchObject({ state: 'finished', validation: 'not_passed', output: { state: 'ready', error: null,
      capture: { paths: ['docs'], maxBytes: 2 * 1024 * 1024 } } })
    const artifact = run.view.output!.artifact!
    expect(artifact.beforeTree).toBe(run.expectedSnapshot)
    expect(artifact.files).toEqual([
      { path: 'docs/a.i18n.yaml', beforeDigest: sha256(BEFORE.a), afterDigest: sha256(AFTER.a), mode: '100644' },
      { path: 'docs/b.i18n.yaml', beforeDigest: sha256(BEFORE.b), afterDigest: sha256(AFTER.b), mode: '100644' },
      { path: 'docs/c.i18n.yaml', beforeDigest: null, afterDigest: sha256(AFTER.c), mode: '100644' },
    ])
    // Generated output is not a pass and does not settle the operation until imported.
    expect(f.executions.operationStatus(run.id)).toBe('unresolved')
    expect(f.text('docs/a.i18n.yaml')).toBe(BEFORE.a)

    const applied = await f.apply(run)
    expect(applied).toMatchObject({ state: 'applied', previousSnapshot: run.expectedSnapshot, resultTree: artifact.afterTree,
      snapshot: artifact.afterTree, treeMatchesArtifact: true, validation: { localExecution: 'not_run' } })
    expect(applied.files).toEqual([
      { path: 'docs/a.i18n.yaml', action: 'updated', previousDigest: sha256(BEFORE.a), digest: sha256(AFTER.a) },
      { path: 'docs/b.i18n.yaml', action: 'updated', previousDigest: sha256(BEFORE.b), digest: sha256(AFTER.b) },
      { path: 'docs/c.i18n.yaml', action: 'created', previousDigest: null, digest: sha256(AFTER.c) },
    ])
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.text('docs/c.i18n.yaml')]).toEqual([AFTER.a, AFTER.b, AFTER.c])
    expect(await f.snapshot()).toBe(applied.snapshot)
    expect(f.fileWrites.map(write => [write.path, write.expectedDigest, write.contentDigest])).toEqual([
      ['docs/a.i18n.yaml', sha256(BEFORE.a), sha256(AFTER.a)], ['docs/b.i18n.yaml', sha256(BEFORE.b), sha256(AFTER.b)],
      ['docs/c.i18n.yaml', null, sha256(AFTER.c)]])
    expect(f.row(run.id)).toMatchObject({ import_state: 'applied', import_snapshot: applied.snapshot, import_error: null })
    expect(f.executions.operationStatus(run.id)).toBe('succeeded')
    expect((await f.executions.read(f.identity, { id: run.id, changeId: f.prepared.id })).output).toMatchObject({ state: 'imported', importedSnapshot: applied.snapshot })
    expect(f.downloads()).toBe(1)
    expect(existsSync(f.outputRoot) ? readdirSync(f.outputRoot) : []).toEqual([])
    // A repeated call returns the durable receipt; nothing is downloaded or written again.
    expect(await f.apply(run)).toMatchObject({ replayed: true, snapshot: applied.snapshot })
    expect(f.downloads()).toBe(1)

    // The generator's exit 0 is not a test pass: validate the new tree separately.
    const check = await f.executions.start(f.identity, { changeId: f.prepared.id, expectedSnapshot: applied.snapshot, command: 'verify', timeoutMs: 20_000 })
    const verified = await f.wait(check.id)
    expect(verified).toMatchObject({ validation: 'passed', snapshotCurrent: 'current', output: null, inputTree: applied.snapshot,
      receipt: { version: 1, outcome: 'passed' } })

    // Same change, same PR: the existing update path pushes one child commit.
    const update = await f.changes.inspectUpdate({ ...f.identity, dir: f.prepared.dir })
    expect(update).toMatchObject({ prNumber: 1, expectedHead: f.initial.head, snapshot: applied.snapshot,
      files: ['docs/a.i18n.yaml', 'docs/b.i18n.yaml', 'docs/c.i18n.yaml'] })
    const pushed = await f.changes.updatePr({ ...f.identity, dir: f.prepared.dir, title: 'Regenerate translation records', body: 'Generated on the team executor',
      expectedSnapshot: update.snapshot, expectedHead: update.expectedHead })
    expect(pushed).toMatchObject({ number: 1, phase: 'confirmed' })
    expect(git(f.bare, 'rev-parse', `${pushed.head}^`)).toBe(f.initial.head)
    expect(git(f.bare, 'rev-parse', `${pushed.head}^{tree}`)).toBe(applied.snapshot)
    expect(git(f.bare, 'rev-parse', f.prepared.branch)).toBe(pushed.head)
    expect(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pulls'))).toHaveLength(1)
  })

  it('refuses a concurrent change before recording any import intent', async () => {
    const f = await fixture(), run = await f.generate()
    writeFileSync(join(f.prepared.dir, 'docs', 'a.i18n.yaml'), 'hash: human edit\n')
    await expect(f.apply(run)).rejects.toBeInstanceOf(RepositoryExecutionSnapshotChanged)
    expect(f.row(run.id)).toMatchObject({ import_state: null, import_json: null })
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.exists('docs/c.i18n.yaml')]).toEqual(['hash: human edit\n', BEFORE.b, false])
    // The change stays usable: nothing is pending.
    expect((await f.changes.inspectUpdate({ ...f.identity, dir: f.prepared.dir })).files).toEqual(['docs/a.i18n.yaml'])
    // A different expected snapshot is refused without a download.
    await expect(f.apply(run, { expectedSnapshot: 'f'.repeat(40) })).rejects.toBeInstanceOf(RepositoryExecutionSnapshotChanged)
  })

  it('refuses when a file outside the generated set changed, although every generated file is still at its before state', async () => {
    const f = await fixture(), run = await f.generate()
    writeFileSync(join(f.prepared.dir, 'docs', 'guide.md'), '# Guide\n\nEdited while the generator ran.\n')
    await expect(f.apply(run)).rejects.toBeInstanceOf(RepositoryExecutionSnapshotChanged)
    expect([f.text('docs/a.i18n.yaml'), f.exists('docs/c.i18n.yaml'), f.row(run.id).import_state]).toEqual([BEFORE.a, false, null])
  })

  it('stops at the next file when it changed after the pre-check, keeping the import pending', async () => {
    let edit = () => {}
    const f = await fixture({ afterFile: index => { if (index === 0) edit() } })
    edit = () => writeFileSync(join(f.prepared.dir, 'docs', 'b.i18n.yaml'), 'hash: concurrent\n')
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toMatchObject({ code: 'import_conflict', message: expect.stringContaining('docs/b.i18n.yaml') })
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.exists('docs/c.i18n.yaml')]).toEqual([AFTER.a, 'hash: concurrent\n', false])
    expect(f.row(run.id)).toMatchObject({ import_state: 'conflict', import_error: 'file_changed' })
  })

  it('has nothing to import when the provider refused the output (outside scope, over the byte limit)', async () => {
    const f = await fixture()
    const outside = await f.generate(['docs/a.i18n.yaml', 'docs/b.i18n.yaml'])
    const large = await f.generate(['docs'], 64)
    expect(outside.view.output).toMatchObject({ state: 'rejected', error: 'output_outside_scope', artifact: null })
    expect(large.view.output).toMatchObject({ state: 'rejected', error: 'output_too_large', artifact: null })
    expect(outside.id).not.toBe(large.id)
    for (const run of [outside, large]) {
      await expect(f.outputs.applyOutput(f.identity, { executionId: run.id, changeId: f.prepared.id, expectedSnapshot: run.expectedSnapshot,
        artifactDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'output_unavailable' })
      expect(f.executions.operationStatus(run.id)).toBe('failed')
    }
    expect([f.text('docs/a.i18n.yaml'), f.exists('docs/c.i18n.yaml'), f.downloads()]).toEqual([BEFORE.a, false, 0])
  })

  it('does not import over an unsettled PR update of the same change', async () => {
    const f = await fixture(), run = await f.generate()
    // An earlier append whose push result is unknown: only the original ledger may settle it.
    f.registry.db.prepare(`INSERT INTO github_change_updates (id,change_id,parent_commit,snapshot,intent,commit_id,state,created_at,updated_at)
      VALUES ('update-unknown',?,?,?,?,?,'unknown',1,1)`).run(f.prepared.id, f.initial.head, 'a'.repeat(40), 'b'.repeat(64), 'c'.repeat(40))
    await expect(f.apply(run)).rejects.toThrow('修改副本已有待核对的发布操作')
    expect([f.text('docs/a.i18n.yaml'), f.exists('docs/c.i18n.yaml'), f.row(run.id).import_state]).toEqual([BEFORE.a, false, null])
  })

  it('refuses a digest that is not the receipt artifact without downloading', async () => {
    const f = await fixture(), run = await f.generate()
    await expect(f.apply(run, { artifactDigest: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'output_mismatch' })
    expect(f.downloads()).toBe(0)
    expect(f.row(run.id).import_state).toBeNull()
  })

  it('refuses bytes altered in transit and records no intent', async () => {
    const f = await fixture(), run = await f.generate()
    f.hooks.response = async (request, response) => {
      if (!request.url.endsWith('/output')) return response
      const bytes = Buffer.from(await response.arrayBuffer()); bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    }
    await expect(f.apply(run)).rejects.toMatchObject({ code: 'output_download_failed', message: expect.stringContaining('invalid_response') })
    expect(f.row(run.id).import_state).toBeNull()
    expect(f.text('docs/a.i18n.yaml')).toBe(BEFORE.a)
  })

  /** The first finished receipt the gateway sees is the one it keeps; tamper before that. */
  function tamper(f: Awaited<ReturnType<typeof fixture>>, edit: (receipt: ExecutorJobReceipt) => void) {
    f.hooks.response = async (request, response) => {
      if (request.method !== 'GET' || request.url.endsWith('/output')) return response
      const receipt = await response.json() as ExecutorJobReceipt
      if (receipt.outputArtifact) edit(receipt)
      return Response.json(receipt)
    }
  }
  it('refuses a manifest that disagrees with the rebuilt tree although digest and bytes match', async () => {
    const f = await fixture()
    tamper(f, receipt => { receipt.outputArtifact!.files.pop() })
    const run = await f.generate()
    expect(run.view.output!.artifact!.files).toHaveLength(2)
    await expect(f.apply(run)).rejects.toMatchObject({ code: 'output_mismatch' })
    expect(f.downloads()).toBe(1)
    expect([f.text('docs/a.i18n.yaml'), f.exists('docs/c.i18n.yaml'), f.row(run.id).import_state]).toEqual([BEFORE.a, false, null])
  })

  it('refuses a manifest path outside the declared capture scope before downloading', async () => {
    const f = await fixture()
    tamper(f, receipt => { receipt.outputArtifact!.files[0]!.path = 'README.md' })
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toMatchObject({ code: 'output_mismatch' })
    expect(f.downloads()).toBe(0)
    expect(f.row(run.id).import_state).toBeNull()
  })

  it('does not replace a finished receipt with a different one', async () => {
    const f = await fixture(), run = await f.generate()
    tamper(f, receipt => { receipt.outputArtifact!.files.pop() })
    await expect(f.executions.read(f.identity, { id: run.id, changeId: f.prepared.id })).rejects.toMatchObject({ code: 'receipt_conflict' })
    expect(JSON.parse(String(f.row(run.id).receipt_json)).outputArtifact.files).toHaveLength(3)
  })

  it('rejects receipts with escaping manifest paths at the client, before the ledger accepts them', async () => {
    const f = await fixture(), run = await f.generate()
    f.hooks.response = async (request, response) => {
      if (request.method !== 'GET') return response
      const receipt = await response.json() as ExecutorJobReceipt; receipt.outputArtifact!.files[0]!.path = '../outside.yaml'
      return Response.json(receipt)
    }
    const view = await f.executions.read(f.identity, { id: run.id, changeId: f.prepared.id })
    expect(view.errorCode).toBe('invalid_response')
    expect(view.output!.artifact!.files[0]!.path).toBe('docs/a.i18n.yaml')
  })

  it('reconciles after a failure following the first of three writes, and blocks publish/edit/checks until then', async () => {
    const f = await fixture({ afterFile: index => { if (index === 0) throw new Error('simulated process failure after first file') } })
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toThrow('simulated process failure')
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.exists('docs/c.i18n.yaml')]).toEqual([AFTER.a, BEFORE.b, false])
    f.reopen()
    const row = f.row(run.id)
    expect(row.import_state).toBe('applying')
    expect(JSON.parse(String(row.import_json)).files.map((file: { applied: boolean }) => file.applied)).toEqual([true, false, false])
    const pending = { name: 'RepositoryExecutionImportPending' }
    await expect(f.changes.inspectUpdate({ ...f.identity, dir: f.prepared.dir })).rejects.toMatchObject(pending)
    await expect(f.changes.updatePr({ ...f.identity, dir: f.prepared.dir, title: 't', body: 'b', expectedSnapshot: 'a'.repeat(40),
      expectedHead: f.initial.head })).rejects.toMatchObject(pending)
    await expect(f.changes.publish({ ...f.identity, dir: f.prepared.dir, title: 't', body: 'b', expectedSnapshot: 'a'.repeat(40) })).rejects.toMatchObject(pending)
    await expect(f.files.read(f.identity, { changeId: f.prepared.id, path: 'docs/guide.md' })).rejects.toBeInstanceOf(RepositoryExecutionImportPending)
    await expect(f.files.write(f.identity, { changeId: f.prepared.id, path: 'docs/guide.md', expectedSnapshot: 'a'.repeat(40),
      expectedDigest: sha256('x'), content: 'x' })).rejects.toBeInstanceOf(RepositoryExecutionImportPending)
    await expect(f.executions.start(f.identity, { changeId: f.prepared.id, expectedSnapshot: run.expectedSnapshot, command: 'verify', timeoutMs: 20_000 }))
      .rejects.toMatchObject({ code: 'import_pending' })
    expect((await f.executions.read(f.identity, { id: run.id, changeId: f.prepared.id }))).toMatchObject({ snapshotCurrent: 'stale',
      output: { state: 'importing' } })
    expect(f.executions.operationStatus(run.id)).toBe('unresolved')

    const downloads = f.downloads()
    const resumed = await f.apply(run)
    expect(resumed).toMatchObject({ state: 'applied', resumed: true, treeMatchesArtifact: true, snapshot: run.view.output!.artifact!.afterTree })
    expect(f.downloads()).toBe(downloads) // recorded blobs, no second download
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.text('docs/c.i18n.yaml')]).toEqual([AFTER.a, AFTER.b, AFTER.c])
    expect((await f.changes.inspectUpdate({ ...f.identity, dir: f.prepared.dir })).snapshot).toBe(resumed.snapshot)
  })

  it('finishes an import whose last write happened but whose completion was not recorded', async () => {
    const f = await fixture({ afterFile: index => { if (index === 2) throw new Error('failure after last file') } })
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toThrow('failure after last file')
    f.reopen()
    expect(f.row(run.id).import_state).toBe('applying')
    expect(await f.apply(run)).toMatchObject({ resumed: true, treeMatchesArtifact: true })
  })

  it('stops on a file that is neither before nor after, keeps the gate, and resumes once restored', async () => {
    const f = await fixture({ afterFile: index => { if (index === 0) throw new Error('failure after first file') } })
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toThrow('failure after first file')
    f.reopen()
    writeFileSync(join(f.prepared.dir, 'docs', 'b.i18n.yaml'), 'hash: someone else\n')
    await expect(f.apply(run)).rejects.toMatchObject({ code: 'import_conflict', message: expect.stringContaining('docs/b.i18n.yaml') })
    expect(f.row(run.id)).toMatchObject({ import_state: 'conflict', import_error: 'file_changed' })
    expect(f.text('docs/b.i18n.yaml')).toBe('hash: someone else\n')
    await expect(f.changes.inspectUpdate({ ...f.identity, dir: f.prepared.dir })).rejects.toMatchObject({ name: 'RepositoryExecutionImportPending' })
    writeFileSync(join(f.prepared.dir, 'docs', 'b.i18n.yaml'), BEFORE.b)
    expect(await f.apply(run)).toMatchObject({ resumed: true, treeMatchesArtifact: true })
    expect(f.row(run.id).import_state).toBe('applied')
  })

  it('does not continue after permission is revoked while file authorizations are awaited', async () => {
    const f = await fixture(), run = await f.generate()
    let grants = 0
    const identity: RepositoryExecutionOutputIdentity = { ...f.identity, async authorizeFileWrite(access) {
      const grant = await f.identity.authorizeFileWrite!(access)
      if (++grants === 2) f.state.writeAllowed = false
      return grant
    } }
    await expect(f.outputs.applyOutput(identity, { executionId: run.id, changeId: f.prepared.id, expectedSnapshot: run.expectedSnapshot,
      artifactDigest: run.view.output!.artifact!.digest })).rejects.toThrow('repository write permission revoked')
    expect(f.row(run.id).import_state).toBeNull()
    expect([f.text('docs/a.i18n.yaml'), f.exists('docs/c.i18n.yaml')]).toEqual([BEFORE.a, false])
  })

  it('does not write the next file after the Work stops between writes, then resumes when current again', async () => {
    let stop = () => {}
    const f = await fixture({ afterFile: index => { if (index === 0) stop() } })
    stop = () => { f.state.authorized = false }
    const run = await f.generate()
    await expect(f.apply(run)).rejects.toThrow('original Work stopped')
    expect(f.row(run.id).import_state).toBe('applying')
    expect([f.text('docs/a.i18n.yaml'), f.text('docs/b.i18n.yaml'), f.exists('docs/c.i18n.yaml')]).toEqual([AFTER.a, BEFORE.b, false])
    f.state.authorized = true
    stop = () => {}
    expect(await f.apply(run)).toMatchObject({ resumed: true, treeMatchesArtifact: true })
  })

  it('does not import when authority changes while the artifact is downloaded', async () => {
    const f = await fixture(), run = await f.generate()
    f.hooks.response = async (request, response) => { if (request.url.endsWith('/output')) f.state.repoAllowed = false; return response }
    await expect(f.apply(run)).rejects.toThrow()
    expect(f.row(run.id).import_state).toBeNull()
    expect(f.text('docs/a.i18n.yaml')).toBe(BEFORE.a)
  })
})

describe('protocol 1 compatibility and schema', () => {
  it('sends the exact six-field v1 request and stores a v1 receipt when no capture is declared', async () => {
    const f = await fixture()
    const expectedSnapshot = await f.snapshot()
    const started = await f.executions.start(f.identity, { changeId: f.prepared.id, expectedSnapshot, command: 'verify', timeoutMs: 20_000 })
    const body = JSON.parse(f.sent.find(request => request.method === 'POST')!.body!)
    expect(Object.keys(body)).toEqual(['repo', 'baseSha', 'inputTree', 'patch', 'command', 'timeoutMs'])
    const view = await f.wait(started.id)
    expect(view.output).toBeNull()
    expect(Object.keys(view.receipt!)).toEqual(['version', 'id', 'digest', 'state', 'outcome', 'createdAt', 'startedAt', 'finishedAt',
      'deadline', 'cleanup', 'result'])
    expect(view.receipt).toMatchObject({ version: 1, digest: sha256(JSON.stringify(body)) })
    const row = f.row(started.id)
    expect(row).toMatchObject({ capture_json: null, import_state: null, digest: sha256(JSON.stringify(body)),
      operation_key: sha256(JSON.stringify(['github_execution_v1', f.identity.workKey, f.identity.taskId, f.prepared.id, expectedSnapshot, 'verify', 20_000])) })
    await expect(f.outputs.applyOutput(f.identity, { executionId: started.id, changeId: f.prepared.id, expectedSnapshot,
      artifactDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'output_unavailable' })
  })

  it('adds the nullable import columns to an existing ledger idempotently, keeping old rows', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE github_executions (id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL,
      requester_open_id TEXT NOT NULL, work_key TEXT NOT NULL, task_id INTEGER NOT NULL, origin_run_id TEXT NOT NULL, change_id TEXT NOT NULL,
      repo TEXT NOT NULL, base_sha TEXT NOT NULL, input_tree TEXT NOT NULL, input_snapshot TEXT NOT NULL, command TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL, digest TEXT NOT NULL, submission_status TEXT NOT NULL CHECK (submission_status IN ('claimed','unknown','not_sent','rejected','accepted')),
      request_seq INTEGER NOT NULL DEFAULT 0, receipt_seq INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, error_code TEXT, stop_requested_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO github_executions VALUES ('exec-old','key','s','o','w',1,'r','c','org/demo','${'a'.repeat(40)}','${'b'.repeat(40)}','${'b'.repeat(40)}',
        'npm test',1000,'${'c'.repeat(64)}','accepted',1,1,NULL,NULL,NULL,1,1);`)
    ensureGitHubExecutionSchema(db)
    const first = JSON.stringify(db.prepare('PRAGMA table_info(github_executions)').all())
    ensureGitHubExecutionSchema(db)
    expect(JSON.stringify(db.prepare('PRAGMA table_info(github_executions)').all())).toBe(first)
    expect(db.prepare('SELECT capture_json,import_state,import_json,import_error,import_snapshot,import_updated_at,command FROM github_executions').get())
      .toEqual({ capture_json: null, import_state: null, import_json: null, import_error: null, import_snapshot: null, import_updated_at: null, command: 'npm test' })
    expect(() => db.prepare("UPDATE github_executions SET import_state='bogus'").run()).toThrow()
    const fresh = new DatabaseSync(':memory:'); ensureGitHubExecutionSchema(fresh)
    expect((fresh.prepare('PRAGMA table_info(github_executions)').all() as { name: string }[]).map(column => column.name))
      .toEqual((db.prepare('PRAGMA table_info(github_executions)').all() as { name: string }[]).map(column => column.name))
    db.close(); fresh.close()
  })
})

describe('executor client protocol 2 parsing and bounded download (unit)', () => {
  const JOB = 'friday-job-output-000001', ORIGIN = 'https://executor.example.test'
  const artifact = { id: 'patch-1', digest: sha256('patch-bytes'), bytes: 11, beforeTree: 'a'.repeat(40), afterTree: 'b'.repeat(40),
    files: [{ path: 'docs/a.yaml', beforeDigest: 'c'.repeat(64), afterDigest: 'd'.repeat(64), mode: '100644' }] }
  const receipt = (overrides: Record<string, unknown> = {}) => ({ version: 2, id: JOB, digest: 'e'.repeat(64), state: 'finished', outcome: 'source_changed',
    createdAt: 1, startedAt: 2, finishedAt: 3, deadline: 4, cleanup: 'confirmed',
    result: { status: 'source_changed', beforeTree: 'a'.repeat(40), afterTree: 'b'.repeat(40), exitCode: 0, runtime: 'rootless-docker', phase: 'command',
      output: { stdout: '', stderr: '', truncated: false } }, outputArtifact: artifact, outputError: null, ...overrides })
  const client = (respond: (request: ExecutorTransportRequest) => Response) => new ExecutorClient({ baseUrl: `${ORIGIN}/friday-executor`, secret: SECRET },
    async request => respond(request))
  it('accepts a consistent v2 receipt and rejects contradictory ones', async () => {
    expect(await client(() => Response.json(receipt())).read(JOB, () => {})).toMatchObject({ version: 2, outputArtifact: artifact, outputError: null })
    for (const bad of [{ version: 3 }, { outputArtifact: { ...artifact, files: [{ ...artifact.files[0], path: '../x' }] } },
      { outputArtifact: { ...artifact, files: [{ ...artifact.files[0], path: 'a/.git/config' }] } },
      { outputArtifact: { ...artifact, files: [{ ...artifact.files[0], mode: '120000' }] } },
      { outputArtifact: { ...artifact, afterTree: 'f'.repeat(40) } }, { outputError: 'output_outside_scope' },
      { outputArtifact: { ...artifact, bytes: 3 * 1024 * 1024 } }, { outputArtifact: undefined }]) {
      const error = await client(() => Response.json(receipt(bad))).read(JOB, () => {}).catch(error => error)
      expect(error).toBeInstanceOf(ExecutorClientError); expect(error.code).toBe('invalid_response')
    }
    expect(await client(() => Response.json(receipt({ outputArtifact: null, outputError: 'output_outside_scope' }))).read(JOB, () => {}))
      .toMatchObject({ outputArtifact: null, outputError: 'output_outside_scope' })
  })
  it('downloads only the fixed output path, bounded by and verified against the receipt', async () => {
    const paths: string[] = []
    const ok = client(request => { paths.push(new URL(request.url).pathname); return new Response('patch-bytes', { status: 200 }) })
    expect((await ok.download(JOB, artifact, () => {})).toString()).toBe('patch-bytes')
    expect(paths).toEqual([`/friday-executor/jobs/${JOB}/output`])
    const cases: [Response, string, string][] = [
      [new Response('patch-bytez', { status: 200 }), 'invalid_response', 'read_failed'],
      [new Response('patch-bytes-and-more', { status: 200 }), 'output_limit', 'read_failed'],
      [new Response('patch-bytes', { status: 200, headers: { 'content-length': '99' } }), 'output_limit', 'read_failed'],
      [Response.json({ error: 'artifact_expired' }, { status: 410 }), 'expired', 'read_failed'],
      [Response.json({ error: 'output_unavailable' }, { status: 404 }), 'not_found', 'read_failed'],
      [new Response('patch-bytes', { status: 202 }), 'invalid_response', 'read_failed'],
    ]
    for (const [response, code, result] of cases) {
      await expect(client(() => response).download(JOB, artifact, () => {})).rejects.toMatchObject({ code, result })
    }
    await expect(ok.download(JOB, { digest: 'bad', bytes: 1 }, () => {})).rejects.toMatchObject({ code: 'invalid_request', result: 'not_sent' })
    await expect(ok.download(JOB, artifact, () => { throw new Error('revoked') })).rejects.toMatchObject({ code: 'authorization_changed', result: 'not_sent' })
  })
  it('keeps submit byte-identical to v1 without capture and rejects an unsafe capture before sending', async () => {
    const bodies: string[] = []
    const c = client(request => { bodies.push(request.body!); return Response.json({ ...receipt(), version: 1, state: 'queued', outcome: null, startedAt: null,
      finishedAt: null, deadline: null, cleanup: 'not_started', result: null, outputArtifact: undefined, outputError: undefined,
      digest: sha256(request.body!) }, { status: 202 }) })
    const input = { repo: 'org/demo', baseSha: 'a'.repeat(40), inputTree: 'b'.repeat(40), patch: '', command: 'npm test', timeoutMs: 1000 }
    await c.submit(JOB, input, () => {})
    expect(bodies[0]).toBe(JSON.stringify(input))
    for (const capture of [{ kind: 'repository_patch', paths: ['../x'], maxBytes: 1 }, { kind: 'repository_patch', paths: [], maxBytes: 1 },
      { kind: 'other', paths: ['docs'], maxBytes: 1 }, { kind: 'repository_patch', paths: ['docs'], maxBytes: 3 * 1024 * 1024 }]) {
      expect(() => c.submit(JOB, { ...input, capture } as never, () => {})).toThrow(ExecutorClientError)
    }
    expect(bodies).toHaveLength(1)
  })
})

describe('error classes', () => {
  it('reports an unsettled import with a fixed, actionable message', () => {
    const error = new RepositoryExecutionImportPending('exec-1', 'conflict')
    expect(error).toBeInstanceOf(RepositoryExecutionError)
    expect(error.code).toBe('import_pending'); expect(error.message).toContain('github_apply_change_check_output')
  })
})
