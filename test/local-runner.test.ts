import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { LocalRunner, localReceipt } from '../integrations/dsh/lib/local-runner.js'

const runners: LocalRunner[] = []
afterEach(() => runners.splice(0).forEach(runner => runner.close()))
const events = (body = 'Useful answer.') => [
  { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'Private reasoning' }, { type: 'text', text: body }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
function fixture(prior?: any) {
  let idle: () => void = () => {}, connected = true, remoteStop = false, delivered = false
  const deviceId = prior?.deviceId ?? randomUUID(), id = prior?.id ?? randomUUID(), store = new Map<string, any>()
  const record = prior && structuredClone(prior); if (record) store.set('local-execution', record)
  const work = { id, deviceId, fingerprint: 'a'.repeat(64), revision: 1, state: 'queued', text: 'Review the repo.', material: '[PR](https://github.com/example/repo/pull/7)' }
  const client = { read: (key: string) => key === 'connection' ? connected ? { id: deviceId, expiresAt: Date.now() + 1000000 } : null : structuredClone(store.get(key)),
    save: (key: string, value: unknown) => store.set(key, structuredClone(value)),
    request: vi.fn(async (_id: string, input: any) => {
      if (input.operation === 'local-get') return structuredClone(work)
      if (input.operation === 'local-claim') { work.state = 'running'; return { deadline: Date.now() + 600000 } }
      if (input.operation === 'local-stop') { remoteStop = true; return {} }
      if (input.operation === 'local-event') { if (input.state === 'completed') delivered = true; return { stop: remoteStop, state: remoteStop ? 'stopping' : input.state } }
      throw new Error('unexpected')
    }) }
  const agent = { whenIdle: vi.fn(() => new Promise<void>(resolve => { idle = resolve })), cancel: vi.fn(() => idle()) }
  const sessions = { create: vi.fn(async () => ({})), prompt: vi.fn(async (_request: any, signal: AbortSignal) => {
    // Match the public Host service, whose Remote wrapper supplies this signal
    // only when the request came through the transport.
    signal.throwIfAborted()
    return { accepted: true }
  }), inspect: vi.fn(async () => ({ events: [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { rpcId: store.get('local-execution')?.attempt } } }, ...events(),
  ] })) }
  const agents = { get: vi.fn(() => agent) }
  const runner = new LocalRunner({ client, sessions, agents, selection: () => ({ provider: 'local-account', model: 'selected-model' }) })
  runners.push(runner)
  return { runner, work, client, sessions, agents, agent, store, idle: () => idle(), disconnect: () => { connected = false }, remoteStop: () => { remoteStop = true }, delivered: () => delivered,
    start: () => runner.start({ id, fingerprint: work.fingerprint, directory: '/tmp', model: 'local-account / selected-model' }) }
}
describe('DSH local work runner', () => {
  it('starts one ordinary session after a claim, passes only selected material, and returns one final receipt', async () => {
    const f = fixture(), first = await f.start()
    expect(await f.start()).toEqual(first)
    expect(f.sessions.create).toHaveBeenCalledTimes(1); expect(f.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(f.sessions.prompt.mock.calls[0]![0]).toMatchObject({ sessionId: first.sessionId, content: [{ type: 'text', text: expect.stringContaining('<friday_context>') }] })
    expect(f.sessions.prompt.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(f.sessions.prompt.mock.calls[0]![1].aborted).toBe(false)
    expect(f.delivered()).toBe(false)
    f.idle(); await vi.waitFor(() => expect(f.delivered()).toBe(true))
    expect(f.store.get('local-execution')).toMatchObject({ phase: 'completed', reported: true })
    expect(JSON.stringify(f.client.request.mock.calls)).not.toContain('Private reasoning')
  })
  it('cancels on a Feishu stop or lost connection, and does not publish a late answer', async () => {
    const f = fixture(); await f.start(); f.remoteStop(); await f.runner.poll()
    await vi.waitFor(() => expect(f.store.get('local-execution').phase).toBe('stopped'))
    expect(f.agent.cancel).toHaveBeenCalled(); expect(f.delivered()).toBe(false)
    expect(f.sessions.prompt.mock.calls[0]![1].aborted).toBe(true)
    const g = fixture(); await g.start(); g.disconnect(); await g.runner.poll()
    expect(g.agent.cancel).toHaveBeenCalled()
    await vi.waitFor(() => expect(g.store.get('local-execution').phase).toBe('stopped'))
    expect(g.store.get('local-execution').reported).not.toBe(true)
  })
  it('aborts prompt admission when stopped while the session is being created', async () => {
    const f = fixture()
    let created!: () => void
    f.sessions.create.mockImplementation(() => new Promise(resolve => { created = () => resolve({}) }))
    const starting = f.start()
    await vi.waitFor(() => expect(f.sessions.create).toHaveBeenCalledTimes(1))
    f.runner.halt('已停止')
    created()
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.sessions.prompt.mock.calls[0]![1].aborted).toBe(true)
    expect(f.agent.whenIdle).not.toHaveBeenCalled()
    expect(f.delivered()).toBe(false)
  })
  it('never starts a model during restart recovery and retries only the durable result', async () => {
    const f = fixture({ id: randomUUID(), deviceId: randomUUID(), attempt: randomUUID(), sessionId: randomUUID(), phase: 'running' })
    await f.runner.ready
    expect(f.sessions.create).not.toHaveBeenCalled(); expect(f.sessions.prompt).not.toHaveBeenCalled()
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.store.get('local-execution')).toMatchObject({ phase: 'completed', reported: true })
  })
  it('rejects a changed model, invalid directory or stale material before creating a session', async () => {
    const f = fixture()
    await expect(f.runner.start({ id: f.work.id, fingerprint: f.work.fingerprint, directory: '/tmp', model: 'other' })).rejects.toThrow('模型已变化')
    await expect(f.runner.start({ id: f.work.id, fingerprint: 'b'.repeat(64), directory: '/tmp', model: 'local-account / selected-model' })).rejects.toThrow('工作或设备已变化')
    expect(f.sessions.create).not.toHaveBeenCalled()
  })
  it('does not report a nonexistent session or permanently block later work after a refused claim', async () => {
    const f = fixture(), original = f.client.request.getMockImplementation()!
    f.client.request.mockImplementation(async (id, command) => {
      if (command.operation === 'local-claim') throw Object.assign(new Error('stopped before start'), { code: 'conflict' })
      return original(id, command)
    })
    await expect(f.start()).rejects.toThrow('stopped before start')
    expect(f.store.get('local-execution')).toMatchObject({ phase: 'interrupted', reported: true })
    await expect(f.start()).rejects.toThrow('尚未成功开始')
    expect(f.sessions.create).not.toHaveBeenCalled()
    expect(f.client.request.mock.calls.filter(([, c]) => c.operation === 'local-event')).toHaveLength(0)
    f.work.id = randomUUID(); f.client.request.mockImplementation(original)
    await expect(f.runner.start({ id: f.work.id, fingerprint: f.work.fingerprint, directory: '/tmp', model: 'local-account / selected-model' })).resolves.toHaveProperty('sessionId')
  })
  it('keeps an ambiguous claim pending through an outage and never invents a running session', async () => {
    const f = fixture(), original = f.client.request.getMockImplementation()!
    f.client.request.mockImplementation(async (id, command) => {
      if (command.operation === 'local-claim') throw new Error('network timeout')
      return original(id, command)
    })
    await expect(f.start()).rejects.toThrow('network timeout')
    await f.runner.poll()
    expect(f.store.get('local-execution').phase).toBe('claiming')
    await expect(f.start()).rejects.toThrow('尚未成功开始')
    expect(f.sessions.create).not.toHaveBeenCalled(); expect(f.sessions.prompt).not.toHaveBeenCalled()
  })
  it('reports a session-creation failure accurately without leaking its raw error or retrying the prompt', async () => {
    const f = fixture()
    f.sessions.create.mockRejectedValue(Object.assign(new Error('required projection unavailable; private diagnostic text'), { code: 'gateway/internal' }))
    await expect(f.start()).rejects.toThrow('DSH 未能创建工作会话')
    await vi.waitFor(() => expect(f.store.get('local-execution').reported).toBe(true))
    const record = structuredClone(f.store.get('local-execution'))
    expect(record).toMatchObject({ phase: 'interrupted', failure: { phase: 'creating_session', code: 'gateway/internal', category: 'projection' },
      receipt: { state: 'interrupted', body: expect.stringContaining('尚未提交本次请求') } })
    expect(JSON.stringify(record)).not.toContain('private diagnostic text')
    expect(f.sessions.prompt).not.toHaveBeenCalled()
    await expect(f.start()).rejects.toThrow('尚未成功开始')
    expect(f.store.get('local-execution')).toEqual(record)
    expect(f.sessions.create).toHaveBeenCalledTimes(1)
  })
  it('refuses partial, failed or tool-only turns as completed answers', () => {
    expect(localReceipt(events('').slice(0, 1)).state).toBe('interrupted')
    expect(localReceipt([{ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }]).state).toBe('failed')
    const stream = events(); stream[0]!.data.message!.content.push({ type: 'tool-call', text: 'not an answer' })
    expect(localReceipt(stream).state).toBe('failed')
    expect(localReceipt(events()).body).toBe('Useful answer.')
  })
  it('ties the receipt to the submitted request, even if the user has already continued in DSH', () => {
    const log = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { rpcId: 'ours' } } }, ...events('Our result.'),
      { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { rpcId: 'later' } } },
      ...events('Unrelated later answer.').map(event => ({ ...event, data: { ...event.data, turn: 2 } }))]
    expect(localReceipt(log, 'ours').body).toBe('Our result.')
    expect(localReceipt(log, 'missing').state).toBe('interrupted')
  })
})
