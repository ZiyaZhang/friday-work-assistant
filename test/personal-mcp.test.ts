import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PersonalMcpConnections } from '../src/personal/mcp-connections.js'
import { DesktopMcp } from '../src/personal/desktop-mcp.js'
import { createPersonalMcpRoutes } from '../src/internal/personal-mcp-routes.js'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(f => f()))
async function fixture() {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close())
  let active = true, catalog = [
    { name: 'search', description: 'Search notes', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'post', description: 'Post a message', inputSchema: { type: 'object' }, readOnly: false },
  ]
  const guard = () => { if (!active) throw new Error('revoked device or run') }
  const remote = { tools: vi.fn(async () => structuredClone(catalog)), call: vi.fn(async () => ({ text: 'result', isError: false })) }
  const deps = { db, key: Buffer.alloc(32, 5), remote, audience: () => {}, now: () => 1000 }
  const store = new PersonalMcpConnections(deps), desktop = new DesktopMcp(store)
  const { id } = (await desktop.prepare('alice', { operation: 'mcp-connect', name: 'Notes', url: 'https://mcp.example.com/mcp', token: 'synthetic-secret' }, guard))() as { id: string }
  const confirm = vi.fn(async () => true)
  return { db, deps, store, desktop, id, remote, guard, confirm, setCatalog: (value: typeof catalog) => { catalog = value }, revoke: () => { active = false },
    invoke: (name = 'search', key = 'run-1') => store.invoke('alice', id, name, { query: 'hello' }, key, guard, confirm) }
}

describe('personal remote tools', () => {
  it('encrypts credentials for each owner and keeps model/device views credential-free', async () => {
    const f = await fixture(), data = JSON.stringify(f.store.list('alice'))
    expect(data).not.toContain('synthetic-secret'); expect(data).not.toContain('secret'); expect(data).not.toContain('owner')
    expect(JSON.stringify(f.db.prepare('SELECT * FROM personal_mcp_connections').all())).not.toContain('synthetic-secret')
    expect(f.store.list('bob')).toEqual([])
    await expect(f.store.invoke('bob', f.id, 'search', {}, 'run', f.guard, f.confirm)).rejects.toThrow('断开')
    const prepare = await f.desktop.prepare('alice', { operation: 'mcp-list' }, f.guard)
    f.revoke(); expect(prepare).toThrow('revoked')
  })
  it('keeps an active tool available when an unrelated disconnected history record is damaged', async () => {
    const f = await fixture(), historicalIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const { id } = (await f.store.prepareConnect('alice', { name: `Old connection ${i}`, url: `https://history-${i}.example.com/mcp` }, f.guard))()
      f.store.disconnect('alice', id, 1)
      historicalIds.push(id)
    }
    // An unreadable archived connection must not prevent an independent active
    // connection from checking its current permissions and returning a receipt.
    f.db.prepare('UPDATE personal_mcp_connections SET record=? WHERE id=?').run('{damaged old record', historicalIds[0]!)
    expect(await f.invoke()).toMatchObject({ state: 'completed', result: 'result' })
    expect(f.store.calls('alice')).toMatchObject([{ state: 'completed', tool: 'search' }])
    expect(f.remote.call).toHaveBeenCalledOnce()
  })
  it('requires a human approval until that exact read tool is allowed and always confirms writes', async () => {
    const f = await fixture()
    await f.invoke(); expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ name: 'Notes', tool: 'search', args: expect.stringContaining('hello') }))
    f.store.configure('alice', f.id, 1, ['search'])
    await f.invoke('search', 'run-2'); expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.remote.call).toHaveBeenLastCalledWith('https://mcp.example.com/mcp', 'synthetic-secret', 'search', { query: 'hello' }, expect.any(Function))
    await f.invoke('post', 'run-3'); expect(f.confirm).toHaveBeenCalledTimes(2)
    expect(() => f.store.configure('alice', f.id, 2, ['post'])).toThrow('只读')
    f.confirm.mockResolvedValueOnce(false)
    expect(await f.invoke('post', 'run-4')).toMatchObject({ state: 'declined' })
    expect(f.remote.call).toHaveBeenCalledTimes(3)
  })
  it('replays a receipt without another call and never retries an unknown side effect after restart', async () => {
    const f = await fixture()
    f.remote.call.mockRejectedValueOnce(new Error('connection lost after accepting write'))
    const first = await f.invoke('post')
    expect(first).toMatchObject({ state: 'uncertain' })
    const restarted = new PersonalMcpConnections(f.deps)
    expect(await restarted.invoke('alice', f.id, 'post', { query: 'hello' }, 'run-1', f.guard, f.confirm)).toMatchObject({ id: first.id, state: 'uncertain' })
    expect(f.remote.call).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledOnce()
  })
  it('invalidates pending approvals and cached results when the connection or schema changes', async () => {
    const f = await fixture()
    const lease = await f.store.checkSource('alice', f.store.source(f.id, 1), f.guard)
    f.confirm.mockImplementationOnce(async () => { f.store.disconnect('alice', f.id, 1); return true })
    await expect(f.invoke('post')).rejects.toThrow(/断开|变化/); expect(f.remote.call).not.toHaveBeenCalled(); expect(lease).toThrow('断开')
    expect(f.store.calls('alice')).toEqual([])
    const g = await fixture(); g.setCatalog([])
    await expect(g.invoke()).rejects.toThrow('说明已变化'); expect(g.remote.call).not.toHaveBeenCalled()
  })
  it('claims one invocation when concurrent calls are approved, and hides results after revocation during a call', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.invoke('post'), f.invoke('post')])
    expect(results.some(r => r.status === 'fulfilled')).toBe(true); expect(f.remote.call).toHaveBeenCalledOnce()
    f.remote.call.mockImplementationOnce(async () => { f.store.disconnect('alice', f.id, 1); return { text: 'private result', isError: false } })
    await expect(f.invoke('search', 'another-run')).rejects.toThrow('断开')
    expect(f.store.calls('alice')).toEqual([])
    expect(JSON.stringify(f.db.prepare('SELECT record FROM personal_mcp_calls').all())).not.toContain('private result')
  })
  it.each([false, true])('shows only receipt metadata after result-source access changes (service error: %s)', async isError => {
    const f = await fixture()
    f.remote.call.mockResolvedValueOnce({ text: 'Result derived from a source that can be revoked', isError })
    const result = await f.invoke('post')
    expect(result.result).toBe('Result derived from a source that can be revoked')
    f.revoke()
    const calls = f.store.calls('alice')
    expect(calls).toEqual([{ id: result.id, name: 'Notes', tool: 'post', at: 1000, state: isError ? 'failed' : 'completed' }])
    expect(JSON.stringify(calls)).not.toContain('Result derived from')
    expect(f.store.calls('bob')).toEqual([])
  })
  it('rejects credential URLs and a stale connect prepared before device revocation', async () => {
    const f = await fixture()
    for (const url of ['http://service.test/mcp', 'https://token@service.test/mcp', 'https://service.test/mcp?token=x'])
      await expect(f.store.prepareConnect('alice', { name: 'bad', url }, f.guard)).rejects.toThrow('HTTPS')
    const save = await f.store.prepareConnect('alice', { name: 'second', url: 'https://other.test/mcp' }, f.guard)
    f.revoke(); expect(save).toThrow('revoked'); expect(f.store.list('alice')).toHaveLength(1)
  })
  it('binds API calls to the current owner and checks material before disclosing arguments', async () => {
    const f = await fixture(), sources = new Set<string>(), run = new AbortController()
    const record = vi.fn((_cap: { owner: string }, ref: string) => { sources.add(ref) })
    const capture = vi.fn(async () => {
      const captured = JSON.stringify([...sources].sort())
      return { assertCurrent: () => {
        f.guard()
        if (JSON.stringify([...sources].sort()) !== captured) throw new Error('source snapshot changed')
      } }
    })
    const routes = createPersonalMcpRoutes<{ owner: string; group?: boolean }>({ connections: f.store,
      requireRun: cap => { if (cap.group) throw new Error('personal only'); return { owner: cap.owner, runId: 'run', assertCurrent: f.guard } },
      capture, operation: cap => ({ cap, signal: run.signal }), requestSignal: () => undefined,
      record, confirm: async (_cap, details) => f.confirm(details), error: (_status, message) => new Error(message) })
    await expect(routes['POST /v1/personal-mcp/tools']({ owner: 'alice', group: true }, {})).rejects.toThrow('personal only')
    const body = { connection_id: f.id, tool: 'post', arguments: { text: 'draft' } }
    capture.mockImplementationOnce(async () => { throw new Error('source no longer available') })
    await expect(routes['POST /v1/personal-mcp/call']({ owner: 'alice' }, body)).rejects.toThrow('source no longer')
    expect(f.remote.call).not.toHaveBeenCalled()
    const receipt = await routes['POST /v1/personal-mcp/call']({ owner: 'alice' }, body) as { id: string; state: string }
    expect(receipt).toMatchObject({ state: 'checking' })
    // Pin the connection before capturing source permissions. Reading the same
    // receipt must not change that snapshot or invalidate subsequent reads.
    expect(sources).toEqual(new Set([f.store.source(f.id, 1)]))
    const result = await routes['POST /v1/personal-mcp/wait']({ owner: 'alice' }, { id: receipt.id, wait_ms: 20_000 })
    expect(result).toMatchObject({ state: 'completed' }); expect(record).toHaveBeenLastCalledWith({ owner: 'alice' }, f.store.source(f.id, 1))
    expect(await routes['POST /v1/personal-mcp/wait']({ owner: 'alice' }, { id: receipt.id, wait_ms: 0 })).toEqual(result)
    expect(await routes['POST /v1/personal-mcp/call']({ owner: 'alice' }, body)).toMatchObject({ id: receipt.id, state: 'completed', result: 'result' })
    expect(f.remote.call).toHaveBeenCalledOnce()
    sources.add('source-added-after-the-original-capture')
    await expect(routes['POST /v1/personal-mcp/wait']({ owner: 'alice' }, { id: receipt.id, wait_ms: 0 })).rejects.toThrow('source snapshot changed')
  })
})
