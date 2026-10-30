import { afterEach, describe, expect, it } from 'vitest'
import { agent, methods, PROTOCOL_VERSION, RequestError, type SessionConfigOption, type SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpRuntime, textBlock } from '../src/acp/runtime.js'
import { createLogger } from '../src/log.js'

const MODEL_A = '["installed-provider","model/a"]'
const MODEL_B = 'opaque:model choice #2'
const config = (value = MODEL_A): SessionConfigOption[] => [{
  id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: value,
  options: [{ group: 'installed-provider', name: 'Installed provider', options: [
    { value: MODEL_A, name: 'Model A' }, { value: MODEL_B, name: 'Model B' },
  ] }],
}, { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }]
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** A protocol peer, not a stub of AcpRuntime: all results and updates cross the SDK connection. */
function mockAcp() {
  let counter = 0
  const sessions = new Map<string, SessionConfigOption[] | null | undefined>()
  const notifiers: Array<(sessionId: string, update: SessionUpdate) => Promise<void>> = []
  const state = {
    nextOptions: config() as SessionConfigOption[] | null | undefined,
    resumeOptions: config(MODEL_B) as SessionConfigOption[] | null | undefined,
    setOptions: config(MODEL_B),
    setCalls: [] as Array<{ sessionId: string; configId: string; value: string | boolean }>,
    prompts: [] as string[],
    newEntered: deferred(), newRelease: undefined as ReturnType<typeof deferred> | undefined,
    resumeEntered: deferred(), resumeRelease: undefined as ReturnType<typeof deferred> | undefined,
    setEntered: deferred(), setRelease: undefined as ReturnType<typeof deferred> | undefined,
    closeEntered: deferred(), closeRelease: undefined as ReturnType<typeof deferred> | undefined,
    promptEntered: deferred(), promptRelease: undefined as ReturnType<typeof deferred> | undefined,
    rejectSet: false,
  }
  const app = agent({ name: 'model-config-peer' })
    .onRequest(methods.agent.initialize, ({ client }) => {
      notifiers.push((sessionId, update) => client.notify(methods.client.session.update, { sessionId, update }))
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
    })
    .onRequest(methods.agent.session.new, async () => {
      const sessionId = `session-${++counter}`
      const configOptions = structuredClone(state.nextOptions)
      sessions.set(sessionId, configOptions)
      state.newEntered.resolve()
      await state.newRelease?.promise
      return { sessionId, configOptions }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      if (!sessions.has(params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
      sessions.set(params.sessionId, structuredClone(state.resumeOptions))
      state.resumeEntered.resolve()
      await state.resumeRelease?.promise
      return { configOptions: state.resumeOptions }
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      state.setCalls.push(params)
      state.setEntered.resolve()
      await state.setRelease?.promise
      if (state.rejectSet) throw RequestError.invalidParams(params, 'model unavailable')
      sessions.set(params.sessionId, structuredClone(state.setOptions))
      return { configOptions: state.setOptions, _meta: { response: 'actual-agent-result' } }
    })
    .onRequest(methods.agent.session.close, async () => {
      state.closeEntered.resolve()
      await state.closeRelease?.promise
      return {}
    })
    .onNotification(methods.agent.session.cancel, () => { state.promptRelease?.resolve() })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      state.prompts.push(params.sessionId)
      state.promptEntered.resolve()
      await state.promptRelease?.promise
      return { stopReason: 'end_turn' }
    })
  return { app, state, notify: (id: string, update: SessionUpdate, connection = notifiers.length - 1) => notifiers[connection]!(id, update) }
}

const runtimes: AcpRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map((r) => r.stop())) })
async function setup(maxConcurrent = 1) {
  const peer = mockAcp()
  const runtime = new AcpRuntime({
    transport: { kind: 'inproc', agent: peer.app }, maxConcurrent,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), log: createLogger('model-runtime-test', 'error'),
  })
  runtimes.push(runtime)
  await runtime.start()
  return { ...peer, runtime }
}
// SDK notify resolves after writing the frame, so wait for the receiving client to handle it.
const received = () => new Promise<void>((r) => setImmediate(r))

describe('ACP model configuration and context occupancy', () => {
  it('preserves the new response, grouped SDK options and opaque directory values in a detached snapshot', async () => {
    const { runtime } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    expect(typeof id).toBe('string')
    expect(runtime.sessionConfig(id)).toEqual({ generation: runtime.currentGeneration, configOptions: config(), contextOccupancy: undefined })
    runtime.sessionConfig(id)!.configOptions![0]!.name = 'mutated outside runtime'
    expect(runtime.sessionConfig(id)!.configOptions![0]!.name).toBe('Model')
  })

  it.each([undefined, null])('does not advertise an empty catalog when new/resume omit configuration: %s', async (missing) => {
    const { runtime, state } = await setup()
    state.nextOptions = missing
    const id = await runtime.newSession('/synthetic/model')
    expect(runtime.sessionConfig(id)!.configOptions).toBeUndefined()
    state.resumeOptions = missing
    expect(await runtime.resumeSession(id, '/synthetic/model')).toBe(true)
    expect(runtime.sessionConfig(id)!.configOptions).toBeUndefined()
  })

  it('uses resume response configuration and leaves another session untouched', async () => {
    const { runtime } = await setup()
    const a = await runtime.newSession('/synthetic/a')
    const b = await runtime.newSession('/synthetic/b')
    expect(await runtime.resumeSession(a, '/synthetic/a')).toBe(true)
    expect(runtime.sessionConfig(a)!.configOptions).toEqual(config(MODEL_B))
    expect(runtime.sessionConfig(b)!.configOptions).toEqual(config())
    expect(await runtime.resumeSession('missing', '/synthetic/none')).toBe(false)
    expect(runtime.sessionConfig('missing')).toBeUndefined()
  })

  it('forwards the exact selected value and returns/caches the actual server result, not the requested value', async () => {
    const { runtime, state } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    state.setOptions = config(MODEL_A) // Server may report a different resulting selection.
    const res = await runtime.setConfigOption(id, 'model', MODEL_B)
    expect(state.setCalls).toEqual([{ sessionId: id, configId: 'model', value: MODEL_B }])
    expect(res).toEqual({ configOptions: config(MODEL_A), _meta: { response: 'actual-agent-result' } })
    res.configOptions[0]!.name = 'changed caller copy'
    expect(runtime.sessionConfig(id)!.configOptions).toEqual(config(MODEL_A))
    state.rejectSet = true
    await expect(runtime.setConfigOption(id, 'model', 'not-in-directory')).rejects.toThrow('model unavailable')
    expect(state.setCalls).toHaveLength(2)
    expect(runtime.sessionConfig(id)!.configOptions).toEqual(config(MODEL_A))
  })

  it('consumes config and usage notifications without subscribers, scoped to the real session', async () => {
    const { runtime, notify } = await setup()
    const a = await runtime.newSession('/synthetic/a')
    const b = await runtime.newSession('/synthetic/b')
    await notify(a, { sessionUpdate: 'config_option_update', configOptions: config(MODEL_B) })
    await notify(a, { sessionUpdate: 'usage_update', used: 42, size: 65536, cost: { amount: 9, currency: 'USD' } })
    await notify('unknown', { sessionUpdate: 'usage_update', used: 9, size: 99 })
    await received()
    expect(runtime.sessionConfig(a)).toEqual({ generation: runtime.currentGeneration, configOptions: config(MODEL_B), contextOccupancy: { used: 42, size: 65536 } })
    expect(runtime.sessionConfig(b)!.contextOccupancy).toBeUndefined()
    expect(runtime.sessionConfig(b)!.configOptions).toEqual(config())
    expect(runtime.sessionConfig('unknown')).toBeUndefined()
    const updates: SessionUpdate[] = []
    runtime.subscribe(a, (update) => updates.push(update))
    await notify(a, { sessionUpdate: 'usage_update', used: 7, size: 65536 })
    await received()
    expect(updates).toEqual([{ sessionUpdate: 'usage_update', used: 7, size: 65536 }])
    expect(runtime.sessionConfig(a)!.contextOccupancy).toEqual({ used: 7, size: 65536 }) // Occupancy may decrease; do not accumulate billing.
  })

  it('uses the SDK boolean discriminator while preserving the existing setter arguments', async () => {
    const { runtime, state } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    await runtime.setConfigOption(id, 'thinking', true)
    expect(state.setCalls).toEqual([{ sessionId: id, configId: 'thinking', value: true, type: 'boolean' }])
  })

  it('invalidates before close ACK and ignores late updates and set responses', async () => {
    const { runtime, state, notify } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    state.setRelease = deferred()
    state.closeRelease = deferred()
    const setting = runtime.setConfigOption(id, 'model', MODEL_B)
    const settingRejected = expect(setting).rejects.toThrow(/关闭|激活/)
    await state.setEntered.promise
    const closing = runtime.closeSession(id)
    await state.closeEntered.promise
    expect(runtime.sessionConfig(id)).toBeUndefined()
    await notify(id, { sessionUpdate: 'config_option_update', configOptions: config(MODEL_B) })
    await received()
    expect(runtime.sessionConfig(id)).toBeUndefined()
    state.setRelease.resolve()
    await settingRejected
    state.closeRelease.resolve()
    await closing
    expect(runtime.sessionConfig(id)).toBeUndefined()
  })

  it('clears old-generation state and obtains fresh resumed configuration on connection restart', async () => {
    const { runtime, notify } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    const oldGeneration = runtime.currentGeneration
    await notify(id, { sessionUpdate: 'usage_update', used: 42, size: 65536 })
    await received()
    await runtime.stop()
    expect(runtime.sessionConfig(id)).toBeUndefined()
    await runtime.start()
    expect(runtime.currentGeneration).toBe(oldGeneration + 1)
    expect(runtime.sessionConfig(id)).toBeUndefined()
    expect(await runtime.resumeSession(id, '/synthetic/model')).toBe(true)
    await notify(id, { sessionUpdate: 'config_option_update', configOptions: config() }, 0).catch(() => undefined)
    await received()
    expect(runtime.sessionConfig(id)).toEqual({ generation: oldGeneration + 1, configOptions: config(MODEL_B), contextOccupancy: undefined })
  })

  it('does not let a set response from before close overwrite a resumed session snapshot', async () => {
    const { runtime, state } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    state.setOptions = config(MODEL_A)
    state.setRelease = deferred()
    const setting = runtime.setConfigOption(id, 'model', MODEL_A)
    const rejected = expect(setting).rejects.toThrow(/关闭|激活/)
    await state.setEntered.promise
    await runtime.closeSession(id)
    await runtime.resumeSession(id, '/synthetic/model')
    state.setRelease.resolve()
    await rejected
    expect(runtime.sessionConfig(id)!.configOptions).toEqual(config(MODEL_B))
  })

  it('cannot reactivate a closed session when an earlier resume response arrives late', async () => {
    const { runtime, state } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    state.resumeRelease = deferred()
    const resuming = runtime.resumeSession(id, '/synthetic/model')
    const rejected = expect(resuming).rejects.toThrow(/关闭|更换/)
    await state.resumeEntered.promise
    await runtime.closeSession(id)
    state.resumeRelease.resolve()
    await rejected
    expect(runtime.sessionConfig(id)).toBeUndefined()
    expect(runtime.isSessionActive(id)).toBe(false)
  })

  it('cannot install a pending old new-session result into a restarted connection', async () => {
    const { runtime, state } = await setup()
    state.newRelease = deferred()
    const creating = runtime.newSession('/synthetic/model')
    const failed = expect(creating).rejects.toThrow()
    await state.newEntered.promise
    await runtime.stop()
    await runtime.start()
    state.newRelease.resolve()
    await failed
    await received()
    expect(runtime.sessionConfig('session-1')).toBeUndefined()
  })
})

describe('ACP prompt admission', () => {
  it('checks the live guard only after Gate admission; a refused dispatch frees the slot without a prompt', async () => {
    const { runtime, state } = await setup()
    const a = await runtime.newSession('/synthetic/a')
    const b = await runtime.newSession('/synthetic/b')
    state.promptRelease = deferred()
    const first = runtime.prompt(a, [textBlock('first')])
    await state.promptEntered.promise
    let allowed = true
    let checks = 0
    const second = runtime.prompt(b, [textBlock('stopped while waiting')], { beforeDispatch: () => {
      checks++
      if (!allowed) throw new Error('run stopped')
    } })
    const rejected = expect(second).rejects.toThrow('run stopped')
    expect(checks).toBe(0)
    allowed = false
    state.promptRelease.resolve()
    await first
    await rejected
    expect(checks).toBe(1)
    expect(state.prompts).toEqual([a])
    expect(runtime.load().active).toBe(0)
    await runtime.prompt(b, [textBlock('new authorized run')], { beforeDispatch: () => undefined })
    expect(state.prompts).toEqual([a, b])
  })

  it('still aborts while queued without running the guard or sending a prompt', async () => {
    const { runtime, state } = await setup()
    const a = await runtime.newSession('/synthetic/a')
    const b = await runtime.newSession('/synthetic/b')
    state.promptRelease = deferred()
    const first = runtime.prompt(a, [textBlock('first')])
    await state.promptEntered.promise
    const abort = new AbortController()
    let checks = 0
    const second = runtime.prompt(b, [textBlock('queued')], { signal: abort.signal, beforeDispatch: () => { checks++ } })
    const rejected = expect(second).rejects.toThrow(/中止/)
    abort.abort()
    await rejected
    expect(checks).toBe(0)
    expect(state.prompts).toEqual([a])
    state.promptRelease.resolve()
    await first
  })

  it('honors cancellation inside the final synchronous guard and rejects an accidentally async guard', async () => {
    const { runtime, state } = await setup()
    const id = await runtime.newSession('/synthetic/model')
    const abort = new AbortController()
    await expect(runtime.prompt(id, [textBlock('cancelled')], { signal: abort.signal, beforeDispatch: () => abort.abort() })).rejects.toThrow()
    await expect(runtime.prompt(id, [textBlock('async guard')], { beforeDispatch: async () => undefined })).rejects.toThrow(/同步/)
    expect(state.prompts).toEqual([])
    expect(runtime.load().active).toBe(0)
  })

  it('does not dispatch a queued request into a newly resumed incarnation of the same session', async () => {
    const { runtime, state } = await setup()
    const a = await runtime.newSession('/synthetic/a')
    const b = await runtime.newSession('/synthetic/b')
    state.promptRelease = deferred()
    const first = runtime.prompt(a, [textBlock('first')])
    await state.promptEntered.promise
    const queued = runtime.prompt(b, [textBlock('old request')])
    const rejected = expect(queued).rejects.toThrow(/会话已更换/)
    await runtime.closeSession(b)
    await runtime.resumeSession(b, '/synthetic/b')
    state.promptRelease.resolve()
    await first
    await rejected
    expect(state.prompts).toEqual([a])
  })
})
