import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensurePersonalMcpSchema, PersonalMcpConnections, type McpConfirmation } from '../src/personal/mcp-connections.js'

const cleanups: (() => Promise<void> | void)[] = []
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const db = new DatabaseSync(':memory:'), run = new AbortController()
  let sourceActive = true, catalog = [
    { name: 'post', description: 'Post the exact supplied message', inputSchema: { type: 'object' }, readOnly: false },
    { name: 'search', description: 'Read notes', inputSchema: { type: 'object' }, readOnly: true },
  ]
  const guard = () => { if (!sourceActive) throw new Error('original source revoked') }
  const remote = { tools: vi.fn(async () => structuredClone(catalog)), call: vi.fn(async () => ({ text: 'authorized reply', isError: false })) }
  const deps = { db, key: Buffer.alloc(32, 4), remote, audience: () => {}, now: () => 1000 }
  const store = new PersonalMcpConnections(deps)
  const { id } = (await store.prepareConnect('alice', { name: 'Notes', url: 'https://mcp.example.com/mcp', token: 'synthetic-token' }, guard))()
  const confirm = vi.fn(async (_details: McpConfirmation) => true)
  const releaseOnCleanup: (() => void)[] = []
  cleanups.push(async () => { store.beginShutdown(); releaseOnCleanup.forEach(release => release()); await store.waitForShutdown(1000); db.close() })
  const start = (args: Record<string, unknown> = { text: 'hello' }, runId = 'run-1') => store.start('alice', id, 'post', args, runId, guard, confirm, run.signal)
  const state = (callId: string) => db.prepare('SELECT state FROM personal_mcp_calls WHERE id=?').get(callId)?.state
  const blockApproval = () => {
    const approval = deferred<boolean>()
    confirm.mockImplementationOnce(() => approval.promise)
    releaseOnCleanup.push(() => approval.resolve(false))
    return approval
  }
  const snapshotRestart = () => {
    const copied = new DatabaseSync(':memory:'); ensurePersonalMcpSchema(copied)
    for (const row of db.prepare('SELECT * FROM personal_mcp_connections').all())
      copied.prepare('INSERT INTO personal_mcp_connections VALUES(?,?,?)').run(row.id!, row.owner!, row.record!)
    for (const row of db.prepare('SELECT * FROM personal_mcp_calls').all())
      copied.prepare('INSERT INTO personal_mcp_calls VALUES(?,?,?,?,?,?,?)').run(row.id!, row.owner!, row.connection_id!, row.revision!, row.request_key!, row.state!, row.record!)
    const restarted = new PersonalMcpConnections({ ...deps, db: copied })
    cleanups.push(() => { restarted.beginShutdown(); copied.close() })
    return { store: restarted, state: (callId: string) => copied.prepare('SELECT state FROM personal_mcp_calls WHERE id=?').get(callId)?.state }
  }
  return { store, db, id, remote, confirm, guard, run, start, state, blockApproval, snapshotRestart, releaseOnCleanup,
    revokeSource: () => { sourceActive = false }, changeCatalog: () => { catalog = catalog.map(tool => ({ ...tool, description: 'Changed meaning' })) },
  }
}

describe('personal MCP durable operation with bounded waits', () => {
  it('reserves before catalog I/O and deduplicates reordered nested arguments while snapshotting their values', async () => {
    const f = await fixture(), catalog = deferred<any[]>()
    f.remote.tools.mockImplementationOnce(() => catalog.promise)
    f.releaseOnCleanup.push(() => catalog.resolve([]))
    const args = { text: 'hello', nested: { b: 2, a: 1 }, ordered: [1, 2] }
    const first = f.start(args), duplicate = f.start({ ordered: [1, 2], nested: { a: 1, b: 2 }, text: 'hello' })
    expect(first.state).toBe('checking'); expect(duplicate.id).toBe(first.id)
    expect(f.db.prepare('SELECT count(*) count FROM personal_mcp_calls').get()?.count).toBe(1)
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.remote.call).not.toHaveBeenCalled()
    args.nested.a = 99
    catalog.resolve(f.store.list('alice')[0]!.tools)
    await flush()
    expect(await f.store.wait('alice', first.id, 'run-1', f.guard, 0)).toMatchObject({ state: 'completed', result: 'authorized reply' })
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.remote.call).toHaveBeenCalledOnce()
    expect(f.remote.call.mock.calls[0]?.[3]).toEqual({ nested: { a: 1, b: 2 }, ordered: [1, 2], text: 'hello' })
  })

  it('keeps the same approval alive beyond 60 seconds when a bounded wait times out or its caller cancels', async () => {
    vi.useFakeTimers()
    const f = await fixture(), approval = f.blockApproval(), receipt = f.start()
    await flush()
    const confirmationSignal = f.confirm.mock.calls[0]![0].signal!
    expect(f.state(receipt.id)).toBe('awaiting_confirmation')
    const bounded = f.store.wait('alice', receipt.id, 'run-1', f.guard, 20_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await bounded).toMatchObject({ id: receipt.id, state: 'awaiting_confirmation' })
    const caller = new AbortController(), waiting = f.store.wait('alice', receipt.id, 'run-1', f.guard, 20_000, caller.signal)
    const aborted = expect(waiting).rejects.toThrow('only this wait')
    caller.abort(new Error('only this wait')); await aborted
    await vi.advanceTimersByTimeAsync(45_000)
    expect(confirmationSignal.aborted).toBe(false)
    expect(f.state(receipt.id)).toBe('awaiting_confirmation')
    expect(f.remote.call).not.toHaveBeenCalled()
    expect(f.start().id).toBe(receipt.id); expect(f.confirm).toHaveBeenCalledOnce()
    approval.resolve(true); await flush()
    expect(await f.store.wait('alice', receipt.id, 'run-1', f.guard, 0)).toMatchObject({ state: 'completed', result: 'authorized reply' })
    expect(f.remote.call).toHaveBeenCalledOnce()
  })

  it.each(['run signal', 'cancel run', 'disconnect', 'configure'])('rejects a late approval after %s', async action => {
    const f = await fixture(), approval = f.blockApproval(), receipt = f.start()
    await flush()
    const signal = f.confirm.mock.calls[0]![0].signal!
    if (action === 'run signal') f.run.abort()
    else if (action === 'cancel run') f.store.cancelRun('run-1')
    else if (action === 'disconnect') f.store.disconnect('alice', f.id, 1)
    else f.store.configure('alice', f.id, 1, ['search'])
    expect(signal.aborted).toBe(true)
    approval.resolve(true); await flush()
    expect(f.state(receipt.id)).toBe('cancelled')
    expect(f.remote.call).not.toHaveBeenCalled()
  })

  it('rechecks the exact catalog after approval instead of executing a definition changed during the wait', async () => {
    const f = await fixture(), approval = f.blockApproval(), receipt = f.start()
    await flush(); f.changeCatalog(); approval.resolve(true); await flush()
    expect(await f.store.wait('alice', receipt.id, 'run-1', f.guard, 0)).toMatchObject({ state: 'failed', note: expect.stringContaining('说明已变化') })
    expect(f.remote.call).not.toHaveBeenCalled()
  })

  it('blocks dispatch when the original material permission changes while awaiting approval', async () => {
    const f = await fixture(), approval = f.blockApproval(), receipt = f.start()
    await flush(); f.revokeSource(); approval.resolve(true); await flush()
    expect(f.state(receipt.id)).toBe('failed')
    expect(f.remote.call).not.toHaveBeenCalled()
    await expect(f.store.wait('alice', receipt.id, 'run-1', () => {}, 0)).rejects.toThrow('original source revoked')
  })

  it('pins reads to the original owner and run and reapplies the original source guard', async () => {
    const f = await fixture(), receipt = f.start(); await flush()
    await expect(f.store.wait('bob', receipt.id, 'run-1', () => {}, 0)).rejects.toThrow('找不到')
    await expect(f.store.wait('alice', receipt.id, 'run-2', () => {}, 0)).rejects.toThrow('不属于')
    f.revokeSource()
    await expect(f.store.wait('alice', receipt.id, 'run-1', () => {}, 0)).rejects.toThrow('original source revoked')
    expect(f.store.calls('alice')[0]).not.toHaveProperty('result')
  })

  it.each(['checking', 'awaiting_confirmation', 'running'])('does not resume a %s operation after a process restart', async phase => {
    const f = await fixture()
    if (phase === 'checking') {
      const catalog = deferred<any[]>(); f.remote.tools.mockImplementationOnce(() => catalog.promise)
      f.releaseOnCleanup.push(() => catalog.resolve([]))
    } else if (phase === 'awaiting_confirmation') f.blockApproval()
    else {
      const result = deferred<{ text: string; isError: boolean }>(); f.remote.call.mockImplementationOnce(() => result.promise)
      f.releaseOnCleanup.push(() => result.resolve({ text: 'late result', isError: false }))
    }
    const receipt = f.start(); await flush(); expect(f.state(receipt.id)).toBe(phase)
    const restarted = f.snapshotRestart(), calls = f.remote.call.mock.calls.length
    const replay = restarted.store.start('alice', f.id, 'post', { text: 'hello' }, 'run-1', () => {}, f.confirm, new AbortController().signal)
    expect(replay).toMatchObject({ id: receipt.id, state: phase === 'running' ? 'uncertain' : 'cancelled' })
    expect(f.remote.call).toHaveBeenCalledTimes(calls)
  })

  it.each(['operation cleanup', 'restart'])('does not release an old result after losing its source guard through %s', async mode => {
    const f = await fixture(), receipt = f.start(); await flush()
    expect(await f.store.wait('alice', receipt.id, 'run-1', f.guard, 0)).toMatchObject({ state: 'completed', result: 'authorized reply' })
    const store = mode === 'restart' ? f.snapshotRestart().store : f.store
    if (mode === 'operation cleanup') { f.store.cancelRun('run-1'); await flush() }
    f.revokeSource()
    const replay = await store.wait('alice', receipt.id, 'run-1', () => {}, 0)
    expect(replay).toMatchObject({ state: 'completed' })
    expect(replay).not.toHaveProperty('result')
  })

  it('retains an uncertain receipt after an external failure and never dispatches it twice', async () => {
    const f = await fixture()
    f.remote.call.mockRejectedValueOnce(new Error('remote accepted the write but dropped its response'))
    const receipt = f.start(); await flush()
    expect(await f.store.wait('alice', receipt.id, 'run-1', f.guard, 0)).toMatchObject({ state: 'uncertain' })
    expect(f.start()).toMatchObject({ id: receipt.id, state: 'uncertain' })
    expect(f.remote.call).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce()
  })

  it('cancels confirmation at shutdown, prevents new starts, and drains after a late confirmation resolves', async () => {
    const f = await fixture(), approval = f.blockApproval(), receipt = f.start(); await flush()
    f.store.beginShutdown()
    expect(f.confirm.mock.calls[0]![0].signal!.aborted).toBe(true)
    expect(() => f.start({ text: 'another' })).toThrow('正在重启')
    expect(await f.store.waitForShutdown(0)).toEqual({ drained: false, pending: 1 })
    approval.resolve(true); await flush()
    expect(await f.store.waitForShutdown(0)).toEqual({ drained: true, pending: 0 })
    expect(f.state(receipt.id)).toBe('cancelled'); expect(f.remote.call).not.toHaveBeenCalled()
  })
})
