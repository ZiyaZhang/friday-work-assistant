import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agent, methods, PROTOCOL_VERSION, RequestError, type McpServer } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntimePool } from '../src/acp/runtime-pool.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { ExecutionSessions, type ManagedExecution } from '../src/core/execution-sessions.js'
import { ExecutionMaterials } from '../src/core/execution-materials.js'
import { RuntimeBindings } from '../src/core/runtime-bindings.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Spaces } from '../src/core/space.js'
import { Bugs } from '../src/core/bugs.js'
import { IssueLinks } from '../src/github/issues.js'
import { ChangeManager } from '../src/github/changes.js'
import { GitHubIdentity } from '../src/github/identity.js'
import { createLogger } from '../src/log.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function peer(mode: string) {
  const state = { counter: 0, created: [] as string[], resumed: [] as string[], closed: [] as string[],
    sessions: new Map<string, { cwd: string; mcpServers: McpServer[] }>(),
    newEntered: deferred(), newRelease: undefined as ReturnType<typeof deferred> | undefined,
    resumeEntered: deferred(), resumeRelease: undefined as ReturnType<typeof deferred> | undefined }
  const app = agent({ name: `execution-${mode}` })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const id = `${mode}-${++state.counter}`
      state.created.push(id); state.sessions.set(id, { cwd: params.cwd, mcpServers: params.mcpServers })
      state.newEntered.resolve(); await state.newRelease?.promise
      return { sessionId: id }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const session = state.sessions.get(params.sessionId)
      state.resumeEntered.resolve(); await state.resumeRelease?.promise
      if (!session || session.cwd !== params.cwd) throw RequestError.resourceNotFound(params.sessionId)
      state.resumed.push(params.sessionId); session.mcpServers = params.mcpServers
      return {}
    })
    .onRequest(methods.agent.session.close, ({ params }) => { state.closed.push(params.sessionId); return {} })
    .onRequest(methods.agent.session.list, () => ({ sessions: [...state.sessions].map(([sessionId, session]) => ({ sessionId, cwd: session.cwd })) }))
  return { app, state }
}
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
/** A source authorization that stays valid; real hosts return the ExecutionSourceAccess guard here. */
const sourcesAllowed = { assertCurrent: (): void => undefined }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'friday-execution-managed-')), registry = new Registry(join(root, 'registry.db'))
  cleanup.push(() => { registry.close(); rmSync(root, { recursive: true, force: true }) })
  const db = registry.db, memory = new ChannelMemory(db), attempts = new RunAttempts(db), contexts = new RuntimeContexts(db)
  const spaces = new Spaces(db), space = spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'alice' })
  const sources = new SourceContexts(registry), bindings = new RuntimeBindings(registry)
  const workspace = peer('workspace'), managedPeer = peer('managed'), log = createLogger('execution-managed-test', 'error')
  const opts = (p: ReturnType<typeof peer>) => ({ transport: { kind: 'inproc' as const, agent: p.app }, log,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) })
  const runtime = new AcpRuntimePool({ workspace: opts(workspace), managed: opts(managedPeer), bindings })
  cleanup.push(() => runtime.stop())
  const files = new ExecutionMaterials(db, join(root, 'material-store'))
  const managed: ManagedExecution = { runtime, root: join(root, 'managed-root'), profileDigest: 'profile-a', files }
  const service = new ExecutionSessions({ registry, attempts, contexts, sources, spaces, runtime, managed })
  const cwd = join(root, 'business'); mkdirSync(cwd); writeFileSync(join(cwd, 'work.txt'), 'BUSINESS_WORK_RETAINED')
  const sessionKey = 'same-work'
  registry.createSession({ sessionKey, chatId: 'dm-alice', chatType: 'p2p', requesterOpenId: 'alice', cwd })
  const bugs = new Bugs(db), issueLinks = new IssueLinks(db)
  const bucket = bugs.record({ spaceId: space.id, chatId: 'dm-alice', messageId: 'business-request', reporterOpenId: 'alice',
    title: 'existing suggestion', text: 'existing report stays intact' }).bucket
  issueLinks.remember({ fingerprint: 'existing-issue', repo: 'synthetic/repo', number: 12, url: 'https://github.invalid/synthetic/repo/issues/12',
    spaceId: space.id, source: 'original-thread' })
  new ChangeManager({ db, cacheDir: join(root, 'git-cache'), log,
    github: new GitHubIdentity({ apiUrl: 'https://github.invalid', token: 'SYNTHETIC', mode: 'pat', allowedRepos: ['synthetic/repo'] }, log) })
  db.prepare(`INSERT INTO github_changes (id,session_key,requester_open_id,cwd,dir,repo,base,base_commit,branch,git_dir,remote_url,state,commit_id,pr_number,pr_url,created_at,updated_at)
    VALUES (?,?,?,?,?,'synthetic/repo','main','original-parent','existing-branch',?,'https://github.invalid/synthetic/repo.git','confirmed','existing-head',13,'https://github.invalid/synthetic/repo/pull/13',1,1)`)
    .run('existing-change', sessionKey, 'alice', cwd, join(cwd, 'change'), join(cwd, 'private-git'))
  let serial = 0, firstTaskId: number | undefined
  const newRun = () => {
    const task = registry.createTaskOnce({ sessionKey, messageId: `request-${++serial}`, requesterOpenId: 'alice', prompt: `real request ${serial}`,
      ...(firstTaskId ? { workFromTaskId: firstTaskId } : {}) }).task
    firstTaskId ??= task.id
    const run = attempts.begin({ workKey: registry.taskWork.get(task.id)!.key, sessionKey, triggerKey: `task:${task.id}`,
      taskId: task.id, stage: 'task', actorOpenId: 'alice', now: serial }, () => registry.startTask(task.id, serial, sessionKey))!
    const check = () => { if (!attempts.isCurrent(run.id)) throw new Error('RUN_STOPPED') }
    return { task, run, check }
  }
  const finish = (active: ReturnType<typeof newRun>) => {
    attempts.finish(active.run.id, 'completed', serial + 100)
    registry.updateTask(active.task.id, { status: 'done', stopReason: 'end_turn', finishedAt: serial + 100 })
  }
  const prepare = (active: ReturnType<typeof newRun>, patch: Partial<Parameters<ExecutionSessions['prepare']>[0]> = {}) => service.prepare({
    session: registry.getSession(sessionKey)!, runId: active.run.id, mode: 'managed', trackSources: true,
    assertCurrent: active.check, readScopes: () => [`space:${space.id}`],
    mcpServers: () => [{ name: 'synthetic', command: 'synthetic-mcp', args: [], env: [{ name: 'RUN_ID', value: active.run.id }] }],
    authorizeMemory: async () => true, authorizeSources: async () => sourcesAllowed, ...patch,
  })
  const materialContext = (active: ReturnType<typeof newRun>, generation: string) => ({ sessionKey, spaceId: space.id,
    generation, runId: active.run.id, assertCurrent: active.check })
  const business = () => Object.fromEntries(['tasks','task_receipts','task_amendments','bug_buckets','bug_reports','github_issue_links','github_changes']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))
  return { root, db, registry, memory, attempts, contexts, sources, spaces, space, bindings, runtime, files, managed, service,
    workspace: workspace.state, managedPeer: managedPeer.state, cwd, sessionKey, bucket, newRun, finish, prepare, materialContext, business }
}

describe('managed ExecutionSessions with real runtime pool, SQLite and material store', () => {
  it('creates an empty execution cwd while preserving business Task, case, Issue/PR and work files', async () => {
    const t = fixture(), active = t.newRun(), before = t.business()
    const prepared = await t.prepare(active)
    expect(prepared).toMatchObject({ fresh: true, reset: false, mode: 'managed' })
    expect(t.bindings.get(prepared.acpSessionId)).toBe('managed')
    expect(t.workspace.created).toEqual([])
    expect(t.registry.getSession(t.sessionKey)?.cwd).toBe(t.cwd)
    const actual = t.managedPeer.sessions.get(prepared.acpSessionId)!
    expect(actual.cwd.startsWith(t.managed.root + '/session-')).toBe(true); expect(actual.cwd).not.toBe(t.cwd)
    expect(t.files.list(t.materialContext(active, prepared.acpSessionId)).items).toEqual([])
    expect(t.business()).toEqual(before)
    expect(readFileSync(join(t.cwd, 'work.txt'), 'utf8')).toBe('BUSINESS_WORK_RETAINED')
  })

  it('never resumes an old workspace ACP as managed, even if memory and old source records look valid', async () => {
    const t = fixture(), original = t.newRun()
    const old = await t.prepare(original, { mode: 'workspace' }); t.finish(original)
    const next = t.newRun(), before = t.business(), prepared = await t.prepare(next)
    expect(prepared).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'managed' })
    expect(prepared.acpSessionId).not.toBe(old.acpSessionId)
    expect(t.managedPeer.resumed).toEqual([]); expect(t.workspace.resumed).toEqual([])
    expect(t.workspace.closed).toContain(old.acpSessionId)
    expect(t.bindings.get(old.acpSessionId)).toBe('workspace'); expect(t.business()).toEqual(before)
  })

  it('normally resumes managed across Runs with the same generation, registered file, and fresh Run capability', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first)
    const receipt = t.files.write(t.materialContext(first, original.acpSessionId), { operationKey: 'artifact', name: 'result.txt', data: Buffer.from('KEPT_MATERIAL'),
      provenance: { sources: t.sources.get(t.sessionKey)!, memoryRefs: [] } })
    const oldCwd = t.managedPeer.sessions.get(original.acpSessionId)!.cwd
    t.finish(first)
    const second = t.newRun(), sourceCheck = vi.fn(async () => sourcesAllowed), result = await t.prepare(second, { authorizeSources: sourceCheck })
    expect(result).toMatchObject({ acpSessionId: original.acpSessionId, fresh: false, reset: false, historyMode: 'continue', mode: 'managed' })
    expect(t.managedPeer.created).toHaveLength(1); expect(t.managedPeer.resumed).toEqual([original.acpSessionId])
    expect(sourceCheck).toHaveBeenCalledWith(expect.objectContaining({ acpSessionId: original.acpSessionId }))
    expect(t.managedPeer.sessions.get(original.acpSessionId)).toMatchObject({ cwd: oldCwd,
      mcpServers: [{ env: [{ name: 'RUN_ID', value: second.run.id }] }] })
    expect(t.files.read(t.materialContext(second, original.acpSessionId), { fileId: receipt.fileId, expectedDigest: receipt.digest }).data.toString()).toBe('KEPT_MATERIAL')
    expect(t.attempts.get(second.run.id)?.acpSessionId).toBe(original.acpSessionId)
  })

  it.each(['managed', 'legacy-workspace'] as const)('uses persistent mode after managed configuration is disabled: %s', async previous => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first, { mode: previous === 'managed' ? 'managed' : 'workspace' })
    t.finish(first); await t.runtime.stop()
    if (previous === 'legacy-workspace') t.db.prepare('DELETE FROM kv WHERE k=?').run(`acp-runtime:${original.acpSessionId}`)
    const standalone = peer('standalone-workspace')
    // A single workspace runtime can see a persisted ID; only the host's recorded mode may permit resuming it.
    standalone.state.sessions.set(original.acpSessionId, { cwd: t.cwd, mcpServers: [] })
    const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: standalone.app },
      log: createLogger('standalone-workspace-test', 'error'), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    cleanup.push(() => runtime.stop())
    const service = new ExecutionSessions({ runtime, registry: t.registry, attempts: t.attempts,
      contexts: t.contexts, sources: t.sources, spaces: t.spaces })
    const next = t.newRun(), before = t.business()
    const result = await service.prepare({ session: t.registry.getSession(t.sessionKey)!, runId: next.run.id,
      mode: 'workspace', trackSources: true, assertCurrent: next.check, readScopes: () => [`space:${t.space.id}`],
      mcpServers: () => [], authorizeMemory: async () => true, authorizeSources: async () => sourcesAllowed })
    if (previous === 'managed') {
      expect(result).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'workspace' })
      expect(result.acpSessionId).not.toBe(original.acpSessionId)
      expect(standalone.state.resumed).toEqual([])
      expect(t.bindings.get(original.acpSessionId)).toBe('managed')
    } else {
      expect(result).toMatchObject({ acpSessionId: original.acpSessionId, fresh: false, reset: false, historyMode: 'continue' })
      expect(standalone.state.resumed).toEqual([original.acpSessionId])
    }
    expect(t.business()).toEqual(before)
  })

  it.each(['profile', 'source-denied', 'memory-denied', 'generation-invalid'] as const)('rebuilds on %s without resuming or exposing old material in the new generation', async reason => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first)
    const receipt = t.files.write(t.materialContext(first, original.acpSessionId), { operationKey: 'artifact', name: 'private.txt', data: Buffer.from('OLD_PRIVATE_MATERIAL'),
      provenance: { sources: t.sources.get(t.sessionKey)!, memoryRefs: [] } })
    if (reason === 'generation-invalid') t.files.invalidateGeneration(t.materialContext(first, original.acpSessionId), 'host-invalidated')
    t.finish(first)
    if (reason === 'profile') t.managed.profileDigest = 'profile-b'
    const next = t.newRun(), before = t.business(), prepared = await t.prepare(next, {
      authorizeSources: async () => reason === 'source-denied' ? false : sourcesAllowed, authorizeMemory: async () => reason !== 'memory-denied' })
    expect(prepared).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'managed' })
    expect(prepared.acpSessionId).not.toBe(original.acpSessionId); expect(t.managedPeer.resumed).toEqual([])
    expect(t.files.list(t.materialContext(next, prepared.acpSessionId)).items).toEqual([])
    expect(() => t.files.read(t.materialContext(next, prepared.acpSessionId), { fileId: receipt.fileId, expectedDigest: receipt.digest })).toThrow()
    expect(t.business()).toEqual(before)
  })

  it('does not create or resume anything after source preflight throws', async () => {
    const t = fixture(), first = t.newRun(); await t.prepare(first); t.finish(first)
    const next = t.newRun()
    await expect(t.prepare(next, { authorizeSources: async () => { throw new Error('SOURCE_CHANGED_DURING_AWAIT') } })).rejects.toThrow('SOURCE_CHANGED')
    expect(t.managedPeer.created).toHaveLength(1); expect(t.managedPeer.resumed).toEqual([])
  })

  it('rejects a real Space rebinding conflict without resuming or allocating another ACP', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
    t.spaces.rebind(t.space.id, 'dm-alice-moved')
    const replacement = t.spaces.ensure({ kind: 'p2p', chatId: 'dm-alice', openId: 'replacement-owner' })
    // The old generation remains in its original Space, even when current source admission succeeds.
    t.sources.initialize({ sessionKey: t.sessionKey, acpSessionId: original.acpSessionId,
      spaceId: replacement.id, chatId: 'dm-alice' }, [`space:${replacement.id}`])
    const next = t.newRun()
    await expect(t.prepare(next, { readScopes: () => [`space:${replacement.id}`] })).rejects.toMatchObject({ code: 'binding_conflict' })
    expect(t.managedPeer.created).toHaveLength(1); expect(t.managedPeer.resumed).toEqual([])
    expect(t.attempts.get(next.run.id)?.acpSessionId).toBeNull()
  })

  it('rebuilds workspace history when its source record is missing, even without an extra source authorizer', async () => {
    const t = fixture(), first = t.newRun(); await t.prepare(first, { mode: 'workspace', authorizeSources: undefined }); t.finish(first)
    t.registry.setKv(`delivery-sources:${t.sessionKey}`, 'null')
    const next = t.newRun(), prepared = await t.prepare(next, { mode: 'workspace', authorizeSources: undefined })
    expect(prepared).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'workspace' })
    expect(t.workspace.resumed).toEqual([]); expect(t.workspace.created).toHaveLength(2)
  })

  it('closes a late newly created ACP after its exact Run was stopped', async () => {
    const t = fixture(), active = t.newRun()
    t.managedPeer.newRelease = deferred()
    const pending = t.prepare(active); await t.managedPeer.newEntered.promise
    t.attempts.requestStop(active.run.id, 'user_requested'); t.managedPeer.newRelease.resolve()
    await expect(pending).rejects.toThrow('RUN_STOPPED')
    expect(t.managedPeer.closed).toEqual(t.managedPeer.created)
    expect(t.registry.getSession(t.sessionKey)?.acpSessionId).toBeNull()
    expect(t.contexts.contextForRun(active.run.id)).toBeUndefined()
    expect(t.db.prepare('SELECT COUNT(*) n FROM execution_material_generations').get()?.n).toBe(0)
  })

  it('closes a late resumed ACP after its next Run was stopped', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
    const next = t.newRun(); t.managedPeer.resumeRelease = deferred()
    const pending = t.prepare(next); await t.managedPeer.resumeEntered.promise
    t.attempts.requestStop(next.run.id, 'user_requested'); t.managedPeer.resumeRelease.resolve()
    await expect(pending).rejects.toThrow('RUN_STOPPED')
    expect(t.runtime.isSessionActive(original.acpSessionId)).toBe(false)
    expect(t.contexts.contextForRun(next.run.id)).toBeUndefined()
    expect(t.managedPeer.created).toHaveLength(1)
  })

  it('closes a resumed ACP if its generation was invalidated during the resume await', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
    const next = t.newRun(); t.managedPeer.resumeRelease = deferred()
    const pending = t.prepare(next); await t.managedPeer.resumeEntered.promise
    t.files.invalidateGeneration(t.materialContext(next, original.acpSessionId), 'host-invalidated')
    t.managedPeer.resumeRelease.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'generation_invalid' })
    expect(t.runtime.isSessionActive(original.acpSessionId)).toBe(false)
    expect(t.contexts.contextForRun(next.run.id)).toBeUndefined()
    expect(t.attempts.get(next.run.id)?.acpSessionId).toBeNull()
    expect(t.managedPeer.created).toHaveLength(1)
  })

  it.each(['run-binding','metadata','generation'] as const)('closes the new ACP if %s registration fails', async phase => {
    const t = fixture(), active = t.newRun()
    if (phase === 'run-binding') t.db.exec("CREATE TRIGGER fail_registration BEFORE UPDATE OF acp_session_id ON run_attempts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RUN_BIND_FAIL'); END;")
    if (phase === 'metadata') t.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON kv WHEN NEW.k LIKE 'managed-execution:%' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_METADATA_FAIL'); END;")
    if (phase === 'generation') t.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON execution_material_generations BEGIN SELECT RAISE(ABORT,'SYNTHETIC_GENERATION_FAIL'); END;")
    await expect(t.prepare(active)).rejects.toThrow('SYNTHETIC_')
    expect(t.managedPeer.created).toHaveLength(1); expect(t.managedPeer.closed).toEqual(t.managedPeer.created)
    expect(t.runtime.isSessionActive(t.managedPeer.created[0]!)).toBe(false)
    expect(t.registry.getSession(t.sessionKey)?.acpSessionId).toBeNull()
    expect(t.db.prepare('SELECT COUNT(*) n FROM execution_material_generations').get()?.n).toBe(0)
    expect(t.attempts.get(active.run.id)?.acpSessionId).toBeNull()
    expect(t.contexts.contextForRun(active.run.id)).toBeUndefined()
  })

  it('rolls back every local registration if source initialization fails after opening the replacement generation', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first)
    const file = t.files.write(t.materialContext(first, original.acpSessionId), { name: 'kept.txt', operationKey: 'kept',
      data: Buffer.from('OLD_GENERATION_REMAINS_VALID'), provenance: { sources: t.sources.get(t.sessionKey)!, memoryRefs: [] } })
    t.finish(first); t.managed.profileDigest = 'profile-b'
    const next = t.newRun(), previousSession = t.registry.getSession(t.sessionKey), previousSources = t.sources.get(t.sessionKey), before = t.business()
    const generations = t.db.prepare('SELECT * FROM execution_material_generations').all()
    t.db.exec("CREATE TRIGGER fail_source_registration BEFORE INSERT ON kv WHEN NEW.k='delivery-sources:same-work' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SOURCE_FAIL'); END;")
    await expect(t.prepare(next)).rejects.toThrow('SYNTHETIC_SOURCE_FAIL')
    expect(t.registry.getSession(t.sessionKey)).toEqual(previousSession)
    expect(t.sources.get(t.sessionKey)).toEqual(previousSources)
    expect(t.attempts.get(next.run.id)?.acpSessionId).toBeNull()
    expect(t.contexts.contextForRun(next.run.id)).toBeUndefined()
    expect(t.db.prepare('SELECT * FROM execution_material_generations').all()).toEqual(generations)
    expect(t.files.read(t.materialContext(next, original.acpSessionId), { fileId: file.fileId, expectedDigest: file.digest }).data.toString()).toBe('OLD_GENERATION_REMAINS_VALID')
    const failedId = t.managedPeer.created[1]!
    expect(t.managedPeer.closed).toContain(failedId)
    expect(t.runtime.isSessionActive(failedId)).toBe(false)
    expect(t.registry.getKv(`managed-execution:${failedId}`)).toBeUndefined()
    expect(t.contexts.get(failedId)).toBeUndefined()
    expect(t.bindings.get(failedId)).toBe('managed')
    expect(t.business()).toEqual(before)
  })

  it('leaves the next Run unbound and the old ACP closed if resume-path context binding fails', async () => {
    const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
    const next = t.newRun(), previousSession = t.registry.getSession(t.sessionKey), before = t.business()
    t.db.exec("CREATE TRIGGER fail_resume_binding BEFORE INSERT ON run_contexts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CONTEXT_BIND_FAIL'); END;")
    await expect(t.prepare(next)).rejects.toThrow('SYNTHETIC_CONTEXT_BIND_FAIL')
    expect(t.attempts.get(next.run.id)?.acpSessionId).toBeNull()
    expect(t.contexts.contextForRun(next.run.id)).toBeUndefined()
    expect(t.registry.getSession(t.sessionKey)).toEqual(previousSession)
    expect(t.runtime.isSessionActive(original.acpSessionId)).toBe(false)
    expect(t.managedPeer.created).toHaveLength(1)
    expect(t.business()).toEqual(before)
  })

  describe('source authorization guard after preflight', () => {
    const revocable = () => {
      const state = { revoked: false }
      return { state, guard: { assertCurrent: (): void => { if (state.revoked) throw new Error('SOURCE_GRANT_CHANGED') } } }
    }

    it('closes a resumed ACP whose source grant changed during the resume await and rebuilds a clean context', async () => {
      const t = fixture(), first = t.newRun(), original = await t.prepare(first)
      const receipt = t.files.write(t.materialContext(first, original.acpSessionId), { operationKey: 'artifact', name: 'private.txt', data: Buffer.from('OLD_PRIVATE_MATERIAL'),
        provenance: { sources: t.sources.get(t.sessionKey)!, memoryRefs: [] } })
      t.finish(first)
      const next = t.newRun(), before = t.business(), { state, guard } = revocable()
      t.managedPeer.resumeRelease = deferred()
      const pending = t.prepare(next, { authorizeSources: async () => guard })
      await t.managedPeer.resumeEntered.promise
      state.revoked = true; t.managedPeer.resumeRelease.resolve()
      const prepared = await pending
      expect(prepared).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'managed' })
      expect(prepared.acpSessionId).not.toBe(original.acpSessionId)
      expect(t.managedPeer.resumed).toEqual([original.acpSessionId])
      expect(t.runtime.isSessionActive(original.acpSessionId)).toBe(false)
      expect(t.attempts.get(next.run.id)?.acpSessionId).toBe(prepared.acpSessionId)
      expect(t.contexts.contextForRun(next.run.id)?.acpId).toBe(prepared.acpSessionId)
      expect(t.files.list(t.materialContext(next, prepared.acpSessionId)).items).toEqual([])
      expect(() => t.files.read(t.materialContext(next, original.acpSessionId), { fileId: receipt.fileId, expectedDigest: receipt.digest })).toThrow()
      expect(t.business()).toEqual(before)
    })

    it('does not resume at all when the source grant changes during the memory authorization await', async () => {
      const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
      const next = t.newRun(), { state, guard } = revocable()
      const prepared = await t.prepare(next, { authorizeSources: async () => guard,
        authorizeMemory: async () => { state.revoked = true; return true } })
      expect(prepared).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild', mode: 'managed' })
      expect(prepared.acpSessionId).not.toBe(original.acpSessionId)
      expect(t.managedPeer.resumed).toEqual([])
      expect(t.runtime.isSessionActive(original.acpSessionId)).toBe(false)
    })

    it('exposes a dispatch guard that carries the source grant for continued history but not for a rebuilt clean context', async () => {
      const t = fixture(), first = t.newRun(), original = await t.prepare(first); t.finish(first)
      const { state, guard } = revocable()
      const next = t.newRun(), resumed = await t.prepare(next, { authorizeSources: async () => guard })
      expect(resumed).toMatchObject({ acpSessionId: original.acpSessionId, historyMode: 'continue' })
      expect(() => resumed.assertCurrent()).not.toThrow()
      state.revoked = true
      expect(() => resumed.assertCurrent()).toThrow('SOURCE_GRANT_CHANGED')
      t.finish(next)
      const clean = t.newRun(), rebuilt = await t.prepare(clean, { authorizeSources: async () => guard })
      expect(rebuilt).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild' })
      expect(() => rebuilt.assertCurrent()).not.toThrow()
      t.attempts.requestStop(clean.run.id, 'user_requested')
      expect(() => rebuilt.assertCurrent()).toThrow('RUN_STOPPED')
    })
  })
})

describe('persistent RuntimeBindings', () => {
  it('imports only genuine Registry legacy IDs and never overwrites managed bindings across SQLite reopen', () => {
    const t = fixture()
    t.registry.updateSession(t.sessionKey, { acpSessionId: 'legacy-id' })
    t.registry.createSession({ sessionKey: 'managed-work', chatId: 'dm-bob', chatType: 'p2p', cwd: '/synthetic' })
    t.registry.updateSession('managed-work', { acpSessionId: 'managed-id' }); t.bindings.bindOnce('managed-id', 'managed')
    t.bindings.importLegacyWorkspace(); t.bindings.importLegacyWorkspace()
    expect(t.bindings.get('legacy-id')).toBe('workspace'); expect(t.bindings.get('managed-id')).toBe('managed')
    expect(t.bindings.get('unseen-id')).toBeUndefined()
    const reopened = new Registry(join(t.root, 'registry.db'))
    try {
      const bindings = new RuntimeBindings(reopened); bindings.importLegacyWorkspace()
      expect(bindings.get('legacy-id')).toBe('workspace'); expect(bindings.get('managed-id')).toBe('managed')
      expect(() => bindings.bindOnce('managed-id', 'workspace')).toThrow()
      expect(bindings.get('managed-id')).toBe('managed')
      reopened.setKv('acp-runtime:corrupt-id', 'unknown-mode')
      expect(() => bindings.get('corrupt-id')).toThrow()
    } finally { reopened.close() }
  })
})
