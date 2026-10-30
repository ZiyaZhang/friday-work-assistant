import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agent, methods, PROTOCOL_VERSION, RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'
import { AcpRuntimePool, type AcpRuntimeBindings, type AcpRuntimeMode } from '../src/acp/runtime-pool.js'
import { textBlock, type AcpRuntimeClient } from '../src/acp/runtime.js'
import { Registry } from '../src/core/registry.js'
import { createLogger } from '../src/log.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise<void>(r => setImmediate(r))
const modelOptions = (value: string): SessionConfigOption[] => [{ id: 'model', name: 'Model', type: 'select',
  category: 'model', currentValue: value, options: [{ value, name: value }] }]

/** Real SDK transports and AcpRuntime, with synthetic platform peers only. */
function peer(mode: string) {
  const state = {
    initialized: 0, failInitialize: false, initializeEntered: deferred(), initializeRelease: undefined as ReturnType<typeof deferred> | undefined,
    newEntered: deferred(), newRelease: undefined as ReturnType<typeof deferred> | undefined,
    resumeEntered: deferred(), resumeRelease: undefined as ReturnType<typeof deferred> | undefined,
    promptEntered: deferred(), promptRelease: undefined as ReturnType<typeof deferred> | undefined,
    counter: 0, ids: new Set<string>(), nextId: undefined as string | undefined,
    resumed: [] as string[], closed: [] as string[], cancelled: [] as string[], prompts: [] as string[],
    setCalls: [] as { sessionId: string; value: string | boolean }[],
  }
  const app = agent({ name: `pool-${mode}` })
    .onRequest(methods.agent.initialize, async () => {
      state.initialized++; state.initializeEntered.resolve(); await state.initializeRelease?.promise
      if (state.failInitialize) throw RequestError.internalError()
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
    })
    .onRequest(methods.agent.session.new, async () => {
      const id = state.nextId ?? `${mode}-${++state.counter}`
      state.ids.add(id); state.newEntered.resolve(); await state.newRelease?.promise
      return { sessionId: id, configOptions: modelOptions(`${mode}-model`) }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      state.resumed.push(params.sessionId); state.resumeEntered.resolve(); await state.resumeRelease?.promise
      if (!state.ids.has(params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
      return { configOptions: modelOptions(`${mode}-resumed-model`) }
    })
    .onRequest(methods.agent.session.close, ({ params }) => { state.closed.push(params.sessionId); return {} })
    .onRequest(methods.agent.session.list, () => ({ sessions: [...state.ids].map(sessionId => ({ sessionId, cwd: `/${mode}` })) }))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      state.setCalls.push(params); return { configOptions: modelOptions(String(params.value)) }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => { state.cancelled.push(params.sessionId); state.promptRelease?.resolve() })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      state.prompts.push(params.sessionId); state.promptEntered.resolve(); await state.promptRelease?.promise
      await client.notify(methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode } } })
      return { stopReason: state.cancelled.includes(params.sessionId) ? 'cancelled' : 'end_turn' }
    })
  return { app, state }
}

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture(maxConcurrent = 1) {
  const workspace = peer('workspace'), managed = peer('managed'), root = mkdtempSync(join(tmpdir(), 'friday-pool-'))
  const path = join(root, 'registry.db')
  let registry = new Registry(path)
  cleanup.push(() => { registry.close(); rmSync(root, { recursive: true, force: true }) })
  const bindings: AcpRuntimeBindings = {
    get: id => registry.getKv(`runtime-mode:${id}`) as AcpRuntimeMode | undefined,
    bindOnce(id, mode) {
      const old = this.get(id)
      if (old !== undefined && old !== mode) throw new Error('binding conflict')
      registry.setKv(`runtime-mode:${id}`, mode)
    },
  }
  function create(override: AcpRuntimeBindings = bindings) {
    const options = (p: ReturnType<typeof peer>) => ({ transport: { kind: 'inproc' as const, agent: p.app },
      onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }), log: createLogger('pool-test', 'error') })
    const pool = new AcpRuntimePool({ workspace: options(workspace), managed: options(managed), bindings: override, maxConcurrent })
    cleanup.push(() => pool.stop())
    return pool
  }
  return { workspace: workspace.state, managed: managed.state, bindings, create, pool: create(),
    reopen() { registry.close(); registry = new Registry(path) } }
}

describe('ACP runtime pool', () => {
  it('preserves workspace catalog defaults and routes each real ID to its own configuration, updates and cancellation', async () => {
    const t = fixture(), p: AcpRuntimeClient = t.pool
    await p.start()
    expect(t.managed.initialized).toBe(0)
    const w = await p.newSession('/workspace')
    await t.pool.startMode('managed')
    const m = await t.pool.newSessionFor('managed', '/managed')
    expect((await p.listSessions()).map(s => s.sessionId)).toEqual([w])
    expect(t.bindings.get(w)).toBe('workspace'); expect(t.bindings.get(m)).toBe('managed')
    await p.setConfigOption(m, 'model', 'managed-selected')
    expect(t.workspace.setCalls).toEqual([])
    expect(t.managed.setCalls).toMatchObject([{ sessionId: m, value: 'managed-selected' }])
    expect(p.sessionConfig(m)?.configOptions?.[0]).toMatchObject({ currentValue: 'managed-selected' })
    const seen: string[] = [], other: string[] = []
    const unsubscribe = p.subscribe(m, u => { if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') seen.push(u.content.text) })
    p.subscribe(w, u => other.push(u.sessionUpdate))
    await p.prompt(m, [textBlock('synthetic')]); await tick()
    expect(seen).toEqual(['managed']); expect(other).toEqual([]); unsubscribe()
    await p.cancel(m); await tick()
    expect(t.managed.cancelled).toEqual([m]); expect(t.workspace.cancelled).toEqual([])
    await p.closeSession(m)
    expect(p.isSessionActive(m)).toBe(false); expect(p.isSessionActive(w)).toBe(true)
    expect(t.bindings.get(m)).toBe('managed')
  })

  it('shares one Gate across processes; a cancelled queued turn never reaches either agent', async () => {
    const t = fixture(), p = t.pool
    await Promise.all([p.start(), p.startMode('managed')])
    const w = await p.newSession('/w'), m = await p.newSessionFor('managed', '/m')
    t.workspace.promptRelease = deferred()
    const first = p.prompt(w, [textBlock('busy')])
    await t.workspace.promptEntered.promise
    const controller = new AbortController(), queued = deferred()
    const second = p.prompt(m, [textBlock('cancel in queue')], { signal: controller.signal, onQueued: () => queued.resolve() })
    const stopped = expect(second).rejects.toThrow(/中止/)
    await queued.promise
    expect(p.load()).toEqual({ active: 1, waiting: 1, max: 1 })
    controller.abort(); await stopped
    expect(t.managed.prompts).toEqual([])
    t.workspace.promptRelease.resolve(); await first
    await p.prompt(m, [textBlock('next')])
    expect(t.managed.prompts).toEqual([m]); expect(p.load()).toEqual({ active: 0, waiting: 0, max: 1 })
  })

  it('retains beforeDispatch admission after waiting on the other mode and releases the shared slot on failure', async () => {
    const t = fixture(), p = t.pool
    await Promise.all([p.start(), p.startMode('managed')])
    const w = await p.newSession('/w'), m = await p.newSessionFor('managed', '/m')
    t.workspace.promptRelease = deferred()
    const first = p.prompt(w, [textBlock('busy')]); await t.workspace.promptEntered.promise
    let permitted = true
    const queued = deferred(), pending = p.prompt(m, [textBlock('late')], { onQueued: () => queued.resolve(),
      beforeDispatch: () => { if (!permitted) throw new Error('source revoked') } })
    const denied = expect(pending).rejects.toThrow('source revoked')
    await queued.promise; permitted = false; t.workspace.promptRelease.resolve()
    await Promise.all([first, denied])
    expect(t.managed.prompts).toEqual([]); expect(p.load().active).toBe(0)
  })

  it('reconstructs managed bindings from SQLite; not-found, repeated startup and legacy import never change their mode', async () => {
    const t = fixture(), p = t.pool
    await p.startMode('managed')
    const id = await p.newSessionFor('managed', '/m'); await p.stop()
    for (let i = 0; i < 2; i++) {
      t.reopen()
      const next = t.create(); await Promise.all([next.start(), next.startMode('managed')])
      expect(next.isSessionActive(id)).toBe(false)
      expect(await next.resumeSession(id, '/m')).toBe(true)
      expect(() => next.registerLegacyWorkspace(id)).toThrow(/绑定/)
      await expect(next.resumeSessionFor('workspace', id, '/m')).rejects.toThrow(/绑定/)
      t.managed.ids.delete(id)
      expect(await next.resumeSession(id, '/m')).toBe(false)
      expect(t.bindings.get(id)).toBe('managed'); expect(t.workspace.resumed).toEqual([])
      t.managed.ids.add(id); await next.stop()
    }
  })

  it('requires explicit trusted import for old workspace IDs and rejects all unbound operations without RPCs', async () => {
    const t = fixture(), p = t.pool
    t.workspace.ids.add('actual-old-registry-id')
    await Promise.all([p.start(), p.startMode('managed')])
    await expect(p.resumeSession('actual-old-registry-id', '/old')).rejects.toThrow(/绑定/)
    await expect(p.resumeSessionFor('managed', 'unknown-managed-id', '/m')).rejects.toThrow(/绑定/)
    await expect(p.prompt('unknown-managed-id', [])).rejects.toThrow(/绑定/)
    await expect(p.cancel('unknown-managed-id')).rejects.toThrow(/绑定/)
    await expect(p.closeSession('unknown-managed-id')).rejects.toThrow(/绑定/)
    await expect(p.setConfigOption('unknown-managed-id', 'model', 'x')).rejects.toThrow(/绑定/)
    expect(() => p.subscribe('unknown-managed-id', () => undefined)).toThrow(/绑定/)
    expect(p.sessionConfig('unknown-managed-id')).toBeUndefined(); expect(p.isSessionActive('unknown-managed-id')).toBe(false)
    expect(t.workspace.resumed).toEqual([]); expect(t.managed.resumed).toEqual([])
    p.registerLegacyWorkspace('actual-old-registry-id')
    expect(await p.resumeSession('actual-old-registry-id', '/old')).toBe(true)
    expect(t.workspace.resumed).toEqual(['actual-old-registry-id'])
  })

  it('closes a newly allocated session if durable registration fails or collides with the other runtime', async () => {
    const t = fixture(), p = t.pool
    await Promise.all([p.start(), p.startMode('managed')])
    const w = await p.newSession('/w')
    t.managed.nextId = w
    await expect(p.newSessionFor('managed', '/m')).rejects.toThrow(/绑定/)
    expect(t.managed.closed).toEqual([w]); expect(t.workspace.closed).toEqual([])
    expect(t.bindings.get(w)).toBe('workspace'); expect(p.isSessionActive(w)).toBe(true)
    const failing = t.create({ ...t.bindings, bindOnce() { throw new Error('disk failure') } })
    t.managed.nextId = 'unrecorded-id'
    await failing.startMode('managed')
    await expect(failing.newSessionFor('managed', '/m')).rejects.toThrow('disk failure')
    expect(t.managed.closed).toContain('unrecorded-id'); expect(t.bindings.get('unrecorded-id')).toBeUndefined()
  })

  it('single-flights mode startup, waits for initialize and never starts the other process implicitly', async () => {
    const t = fixture(), p = t.pool
    t.managed.initializeRelease = deferred()
    const a = p.startMode('managed'), b = p.startMode('managed')
    expect(a).toBe(b)
    await t.managed.initializeEntered.promise
    await expect(p.newSessionFor('managed', '/too-early')).rejects.toThrow(/启动/)
    expect(t.workspace.initialized).toBe(0); expect(t.managed.initialized).toBe(1)
    t.managed.initializeRelease.resolve(); await a
    expect(p.isAlive).toBe(false); expect(p.currentGeneration).toBe(0)
    expect(await p.newSessionFor('managed', '/ready')).toBe('managed-1')
  })

  it('does not preserve failed initialize as alive; retry performs a fresh handshake only in that mode', async () => {
    const t = fixture(), p = t.pool
    t.managed.failInitialize = true
    await expect(p.startMode('managed')).rejects.toThrow()
    await expect(p.newSessionFor('managed', '/failed')).rejects.toThrow(/启动/)
    t.managed.failInitialize = false
    await p.startMode('managed')
    const id = await p.newSessionFor('managed', '/retry')
    expect(p.sessionConfig(id)?.generation).toBe(2)
    expect(t.managed.initialized).toBe(2); expect(t.workspace.initialized).toBe(0)
  })

  it('rejects startup stopped before handshake ACK; a later explicit start succeeds', async () => {
    const t = fixture(), p = t.pool
    t.managed.initializeRelease = deferred()
    const start = p.startMode('managed'), rejected = expect(start).rejects.toThrow()
    await t.managed.initializeEntered.promise
    await p.stopMode('managed'); t.managed.initializeRelease.resolve(); await rejected
    await expect(p.newSessionFor('managed', '/stopped')).rejects.toThrow(/启动/)
    t.managed.initializeRelease = undefined
    await p.startMode('managed')
    const id = await p.newSessionFor('managed', '/next')
    expect(p.isSessionActive(id)).toBe(true)
  })

  it('preserves actual mode generations and active sessions when only the other runtime restarts', async () => {
    const t = fixture(), p = t.pool
    await Promise.all([p.start(), p.startMode('managed')])
    const w = await p.newSession('/w'), m = await p.newSessionFor('managed', '/m')
    await p.stopMode('managed'); await p.startMode('managed'); await p.resumeSession(m, '/m')
    expect(p.currentGeneration).toBe(1); expect(p.sessionConfig(w)?.generation).toBe(1)
    expect(p.sessionConfig(m)?.generation).toBe(2)
    await p.stopMode('workspace')
    expect(p.isAlive).toBe(false); expect(p.isSessionActive(m)).toBe(true)
    expect((await p.prompt(m, [textBlock('still available')])).stopReason).toBe('end_turn')
    await p.stop(); expect(p.isSessionActive(m)).toBe(false)
  })

  it('close invalidates a pending managed resume without touching the workspace session', async () => {
    const t = fixture(), p = t.pool
    await Promise.all([p.start(), p.startMode('managed')])
    const w = await p.newSession('/w'), m = await p.newSessionFor('managed', '/m')
    await p.closeSession(m)
    t.managed.resumeRelease = deferred()
    const resume = p.resumeSession(m, '/m'), rejected = expect(resume).rejects.toThrow(/关闭|更换/)
    await t.managed.resumeEntered.promise
    await p.closeSession(m); t.managed.resumeRelease.resolve(); await rejected
    expect(p.isSessionActive(m)).toBe(false); expect(p.isSessionActive(w)).toBe(true)
    expect(t.workspace.closed).toEqual([]); expect(t.bindings.get(m)).toBe('managed')
  })
})
