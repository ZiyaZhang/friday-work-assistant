import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntimePool } from '../src/acp/runtime-pool.js'
import { ExecutionSessions } from '../src/core/execution-sessions.js'
import { ExecutionMaterials } from '../src/core/execution-materials.js'
import { Registry } from '../src/core/registry.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { RuntimeContexts } from '../src/core/runtime-contexts.js'
import { RuntimeBindings } from '../src/core/runtime-bindings.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Spaces } from '../src/core/space.js'
import { TaskEvents } from '../src/core/task-events.js'
import { createLogger } from '../src/log.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Groups keep one ACP per Work; a private chat (p2p) is one continuous conversation. */
function fixture(chatType: 'p2p' | 'group' = 'group') {
  const root = mkdtempSync(join(tmpdir(), 'friday-execution-work-')), path = join(root, 'registry.db')
  let registry = new Registry(path), attempts = new RunAttempts(registry.db), contexts = new RuntimeContexts(registry.db)
  let sources = new SourceContexts(registry), spaces = new Spaces(registry.db)
  let files = new ExecutionMaterials(registry.db, join(root, 'files'))
  cleanup.push(() => { registry.close(); rmSync(root, { recursive: true, force: true }) })
  const sessionKey = 'one-conversation', chatId = 'alice-dm', actor = 'alice'
  const space = spaces.ensure({ kind: chatType, chatId, openId: actor }), cwd = join(root, 'work'); mkdirSync(cwd)
  registry.createSession({ sessionKey, chatId, chatType, requesterOpenId: actor, cwd })
  const peer = { serial: 0, created: [] as string[], resumed: [] as string[], closed: [] as string[],
    sessions: new Map<string, string>(), entered: deferred(), hold: undefined as ReturnType<typeof deferred> | undefined }
  const app = agent({ name: 'work-isolation' })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const id = `acp-${++peer.serial}`; peer.created.push(id); peer.sessions.set(id, params.cwd)
      peer.entered.resolve(); await peer.hold?.promise; return { sessionId: id }
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      if (peer.sessions.get(params.sessionId) !== params.cwd) throw RequestError.resourceNotFound(params.sessionId)
      peer.resumed.push(params.sessionId); return {}
    })
    .onRequest(methods.agent.session.close, ({ params }) => { peer.closed.push(params.sessionId); return {} })
  const options = { transport: { kind: 'inproc' as const, agent: app }, log: createLogger('work-isolation', 'error'),
    onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) }
  const makeRuntime = () => new AcpRuntimePool({ workspace: options, managed: options, bindings: new RuntimeBindings(registry) })
  let runtime = makeRuntime()
  cleanup.push(() => runtime.stop())
  const service = () => new ExecutionSessions({ runtime, registry, attempts, contexts, sources, spaces,
    managed: { runtime, root: join(root, 'managed'), profileDigest: 'same-profile', files } })
  let serial = 0
  const newRun = (workFromTaskId?: number, stage: 'task' | 'reflect' = 'task') => {
    const messageId = `input-${++serial}`, prompt = `synthetic request ${serial}`
    const task = registry.createTaskOnce({ sessionKey, messageId, requesterOpenId: actor, prompt,
      inbound: { eventId: messageId, messageId, chatId, chatType, senderOpenId: actor, senderType: 'user',
        msgType: 'text', text: prompt, mentions: [], createTimeMs: serial },
      ...(workFromTaskId ? { workFromTaskId } : {}) }).task
    const run = attempts.begin({ workKey: registry.taskWork.get(task.id)!.key, sessionKey, triggerKey: `turn-${serial}`,
      taskId: stage === 'task' ? task.id : undefined, stage, actorOpenId: actor, now: serial })!
    const check = () => { if (!attempts.isCurrent(run.id)) throw new Error('RUN_STOPPED') }
    return { task, run, check }
  }
  const prepare = (active: ReturnType<typeof newRun>, patch: Partial<Parameters<ExecutionSessions['prepare']>[0]> = {}) => service().prepare({
    session: registry.getSession(sessionKey)!, runId: active.run.id, mode: 'managed', trackSources: true,
    assertCurrent: active.check, mcpServers: () => [], readScopes: () => [`space:${space.id}`],
    authorizeMemory: async () => true, authorizeSources: async () => ({ assertCurrent: () => undefined }), ...patch,
  })
  const finish = (active: ReturnType<typeof newRun>) => attempts.finish(active.run.id, 'completed', serial + 100)
  const materialContext = (active: ReturnType<typeof newRun>, generation: string) => ({ sessionKey, spaceId: space.id,
    generation, runId: active.run.id, assertCurrent: active.check })
  const reopen = async () => {
    await runtime.stop()
    registry.close(); registry = new Registry(path); attempts = new RunAttempts(registry.db); contexts = new RuntimeContexts(registry.db)
    sources = new SourceContexts(registry); spaces = new Spaces(registry.db); files = new ExecutionMaterials(registry.db, join(root, 'files'))
    runtime = makeRuntime()
  }
  return { get registry() { return registry }, get attempts() { return attempts }, get contexts() { return contexts },
    get sources() { return sources }, get files() { return files }, get runtime() { return runtime }, peer, sessionKey, space, newRun, finish, prepare, materialContext, reopen }
}

describe('execution history belongs to the real Work, not just its conversation', () => {
  it('a private chat is one conversation: a separate Work continues the same ACP, so earlier turns stay in context', async () => {
    const t = fixture('p2p'), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    const second = t.newRun()
    expect(t.registry.taskWork.get(second.task.id)?.key).not.toBe(t.registry.taskWork.get(first.task.id)?.key)
    const next = await t.prepare(second)
    expect(next).toMatchObject({ acpSessionId: old.acpSessionId, fresh: false, reset: false, historyMode: 'continue' })
    expect(t.peer.created).toHaveLength(1)
  })

  it('starts a separate Work with a new ACP, source manifest and material generation after database reopen', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first)
    t.sources.addChat(t.sessionKey, { chatId: 'other-group', spaceId: 'other-space' })
    const material = t.files.write(t.materialContext(first, old.acpSessionId), { operationKey: 'old-data', name: 'old.txt',
      data: Buffer.from('SYNTHETIC_OTHER_WORK'), provenance: { sources: t.sources.get(t.sessionKey)!, memoryRefs: [] } })
    t.finish(first); await t.runtime.closeSession(old.acpSessionId); await t.reopen()
    const next = t.newRun(), memory = vi.fn(async () => true), source = vi.fn(async () => ({ assertCurrent: () => undefined }))
    const fresh = await t.prepare(next, { authorizeMemory: memory, authorizeSources: source })
    expect(next.run.workKey).not.toBe(first.run.workKey)
    expect(fresh).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild' })
    expect(fresh.acpSessionId).not.toBe(old.acpSessionId); expect(t.peer.resumed).toEqual([])
    expect(memory).toHaveBeenCalledExactlyOnceWith(null); expect(source).not.toHaveBeenCalled()
    expect(t.sources.get(t.sessionKey)).toMatchObject({ acpSessionId: fresh.acpSessionId, chats: [], external: [] })
    expect(t.files.list(t.materialContext(next, fresh.acpSessionId)).items).toEqual([])
    expect(() => t.files.read(t.materialContext(next, fresh.acpSessionId), { fileId: material.fileId, expectedDigest: material.digest })).toThrow()
    expect(t.attempts.get(first.run.id)?.acpSessionId).toBe(old.acpSessionId)
    expect(t.contexts.contextForRun(first.run.id)?.acpId).toBe(old.acpSessionId)
    expect(t.contexts.contextForRun(next.run.id)?.acpId).toBe(fresh.acpSessionId)
  })

  it.each(['task', 'reflect'] as const)('continues the same Work for %s with old source and memory authorization', async stage => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    const next = t.newRun(first.task.id, stage), memory = vi.fn(async () => true), source = vi.fn(async () => ({ assertCurrent: () => undefined }))
    const continued = await t.prepare(next, { authorizeMemory: memory, authorizeSources: source })
    expect(next.run.workKey).toBe(first.run.workKey)
    expect(continued).toMatchObject({ acpSessionId: old.acpSessionId, fresh: false, historyMode: 'continue' })
    expect(memory).toHaveBeenCalledExactlyOnceWith(old.acpSessionId); expect(source).toHaveBeenCalledTimes(1)
  })

  it('continues an actual persisted GitHub CI event on its original Work and ACP', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    const events = new TaskEvents(t.registry)
    const { task } = events.admit({ key: 'same-pr-new-ci-observation', kind: 'github_ci', sourceTaskId: first.task.id,
      targetSessionKey: t.sessionKey, domainId: 'synthetic-change', prompt: 'Synthetic CI evidence: keep the original change.' })
    const run = t.attempts.begin({ workKey: t.registry.taskWork.get(task.id)!.key, sessionKey: t.sessionKey,
      taskId: task.id, triggerKey: 'ci-run', stage: 'task', actorOpenId: 'alice', now: 10 })!
    const parentCurrent = events.lease(task.id)!
    const check = () => { if (!t.attempts.isCurrent(run.id)) throw new Error('RUN_STOPPED'); parentCurrent() }
    const continued = await t.prepare({ task, run, check })
    expect(t.registry.dispatches.get(task.id)?.inbound.senderType).toBe('bot')
    expect(run.workKey).toBe(first.run.workKey)
    expect(continued).toMatchObject({ acpSessionId: old.acpSessionId, fresh: false, historyMode: 'continue' })
  })

  it('rebuilds when returning to Work A after Work B, without importing B as previous history', async () => {
    const t = fixture(), a = t.newRun(), aContext = await t.prepare(a); t.finish(a)
    const b = t.newRun(), bContext = await t.prepare(b)
    t.sources.addChat(t.sessionKey, { chatId: 'only-for-work-b' }); t.finish(b)
    const continuedA = t.newRun(a.task.id), result = await t.prepare(continuedA)
    expect(continuedA.run.workKey).toBe(a.run.workKey)
    expect(new Set([aContext.acpSessionId, bContext.acpSessionId, result.acpSessionId]).size).toBe(3)
    expect(result).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild' })
    expect(t.sources.get(t.sessionKey)?.chats).toEqual([])
    expect(t.peer.resumed).toEqual([])
  })

  it('rebuilds rather than claiming continued history when the same Work ACP no longer exists', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    t.peer.sessions.delete(old.acpSessionId)
    const next = t.newRun(first.task.id), fresh = await t.prepare(next)
    expect(fresh).toMatchObject({ fresh: true, reset: true, historyMode: 'rebuild' })
    expect(fresh.acpSessionId).not.toBe(old.acpSessionId)
    fresh.assertCurrent()
  })

  it('does not reuse an already mixed ACP even when the latest bound Run has the current Work', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    const other = t.newRun(); t.attempts.bindRuntime(other.run.id, old.acpSessionId); t.finish(other)
    const next = t.newRun(other.task.id), fresh = await t.prepare(next)
    expect(fresh).toMatchObject({ fresh: true, historyMode: 'rebuild' })
    expect(fresh.acpSessionId).not.toBe(old.acpSessionId); expect(t.peer.resumed).toEqual([])
  })

  it('does not infer Work ownership for an ACP whose original Run binding is unavailable', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.finish(first)
    t.registry.db.prepare('UPDATE run_attempts SET acp_session_id=NULL WHERE id=?').run(first.run.id)
    const next = t.newRun(first.task.id), fresh = await t.prepare(next)
    expect(fresh).toMatchObject({ fresh: true, historyMode: 'rebuild' })
    expect(fresh.acpSessionId).not.toBe(old.acpSessionId); expect(t.peer.resumed).toEqual([])
  })

  it('does not resume a separate Work in legacy workspace mode without a source authorizer', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first, { mode: 'workspace', authorizeSources: undefined }); t.finish(first)
    const next = t.newRun(), fresh = await t.prepare(next, { mode: 'workspace', authorizeSources: undefined, trackSources: false })
    expect(fresh).toMatchObject({ fresh: true, historyMode: 'rebuild', mode: 'workspace' })
    expect(fresh.acpSessionId).not.toBe(old.acpSessionId); expect(t.peer.resumed).toEqual([])
  })

  it('leaves the old ACP manifest intact when the new Work stops during fresh allocation', async () => {
    const t = fixture(), first = t.newRun(), old = await t.prepare(first); t.sources.addChat(t.sessionKey, { chatId: 'other-group' }); t.finish(first)
    const before = t.sources.get(t.sessionKey), next = t.newRun()
    t.peer.entered = deferred(); t.peer.hold = deferred()
    const pending = t.prepare(next); await t.peer.entered.promise
    t.attempts.requestStop(next.run.id, 'user_requested'); t.peer.hold.resolve()
    await expect(pending).rejects.toThrow('RUN_STOPPED')
    expect(t.sources.get(t.sessionKey)).toEqual(before)
    expect(t.registry.getSession(t.sessionKey)?.acpSessionId).toBe(old.acpSessionId)
    expect(t.contexts.contextForRun(next.run.id)).toBeUndefined()
    expect(t.peer.closed).toContain(t.peer.created.at(-1))
  })
})
