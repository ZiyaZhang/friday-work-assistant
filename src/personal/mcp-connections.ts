import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { RemoteMcp, RemoteTool } from './mcp-transport.js'
import { DeviceError } from './devices.js'
import { withoutRequestLease } from '../core/request-lease.js'

export const mcpConnect = z.object({ name: z.string().trim().min(1).max(80), url: z.url().max(1500), token: z.string().max(8000).optional() }).strict()
interface Connection { id: string; owner: string; name: string; url: string; revision: number; secret: string; tools: RemoteTool[]; automatic: string[]; connected: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value
export interface McpConfirmation { name: string; url: string; tool: string; args: string; signal?: AbortSignal }
interface McpOperation {
  runId: string; owner: string; connectionId: string; cancel: AbortController; settled: Promise<void>
  pending: boolean; observed: boolean; assertCurrent(): void; error?: unknown
}
const pendingStates = new Set(['checking', 'awaiting_confirmation', 'running'])

function waitBounded(settled: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!timeoutMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const done = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('本次等待已取消')) }
    const timer = setTimeout(done, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    settled.then(done, error => { cleanup(); reject(error) })
    if (signal?.aborted) abort()
  })
}
export function ensurePersonalMcpSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_mcp_connections (id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS personal_mcp_owner ON personal_mcp_connections(owner);
    CREATE TABLE IF NOT EXISTS personal_mcp_calls (id TEXT PRIMARY KEY,owner TEXT NOT NULL,connection_id TEXT NOT NULL,revision INTEGER NOT NULL,request_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,record TEXT NOT NULL);`)
}
export class PersonalMcpConnections {
  private readonly operations = new Map<string, McpOperation>()
  private readonly shutdown = new AbortController()
  constructor(private readonly d: { db: DatabaseSync; key: Buffer; remote: RemoteMcp; audience(owner: string): unknown; now?: () => number }) {
    if (d.key.length !== 32) throw new Error('Invalid connection key')
    ensurePersonalMcpSchema(d.db)
    // A process restart never retries an external effect whose receipt is absent.
    d.db.exec("UPDATE personal_mcp_calls SET state='uncertain' WHERE state='running'")
    d.db.exec("UPDATE personal_mcp_calls SET state='cancelled' WHERE state IN ('checking','awaiting_confirmation')")
  }
  private seal(owner: string, id: string, value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.d.key, iv)
    cipher.setAAD(Buffer.from(`personal-mcp:${owner}:${id}`))
    const bytes = Buffer.concat([cipher.update(value), cipher.final()])
    return [iv, cipher.getAuthTag(), bytes].map(v => v.toString('base64url')).join('.')
  }
  private token(c: Connection) {
    const [iv, tag, bytes] = c.secret.split('.').map(v => Buffer.from(v, 'base64url'))
    const decipher = createDecipheriv('aes-256-gcm', this.d.key, iv!)
    decipher.setAAD(Buffer.from(`personal-mcp:${c.owner}:${c.id}`)); decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(bytes!), decipher.final()]).toString()
  }
  private save(c: Connection) { this.d.db.prepare('INSERT INTO personal_mcp_connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(c.id, c.owner, JSON.stringify(c)) }
  private rows(owner: string): Connection[] {
    this.d.audience(owner)
    return this.d.db.prepare('SELECT record FROM personal_mcp_connections WHERE owner=?').all(owner).map(row => JSON.parse(String(row.record)) as Connection)
  }
  private get(owner: string, id: string) {
    this.d.audience(owner)
    const row = this.d.db.prepare('SELECT record FROM personal_mcp_connections WHERE id=? AND owner=?').get(id, owner)
    const c = row ? JSON.parse(String(row.record)) as Connection : undefined
    if (!c?.connected) throw new DeviceError('denied', '这个 MCP 连接已断开，请重新连接。')
    return c
  }
  list(owner: string) { return this.rows(owner).map(({ secret: _secret, owner: _owner, ...c }) => c) }
  async prepareConnect(owner: string, raw: unknown, guard: () => void) {
    guard(); this.d.audience(owner)
    const input = mcpConnect.parse(raw), url = new URL(input.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\r\n]/.test(input.token ?? ''))
      throw new DeviceError('invalid', '请填写不含令牌和跳转参数的 HTTPS MCP 地址，令牌放在单独的输入框。')
    const id = randomUUID(), existing = this.rows(owner), before = digest(existing)
    if (existing.filter(c => c.connected).length >= 10) throw new DeviceError('invalid', '最多连接 10 个 MCP，请先断开不用的连接。')
    let tools: RemoteTool[]
    try { tools = await this.d.remote.tools(url.toString(), input.token ?? '', guard) }
    catch { guard(); throw new DeviceError('unavailable', '没有读到 MCP 工具。请核对地址与凭据；目前支持 Streamable HTTP 和 Bearer 令牌。') }
    const secret = this.seal(owner, id, input.token ?? '')
    return () => {
      guard(); this.d.audience(owner)
      if (digest(this.rows(owner)) !== before) throw new DeviceError('conflict', '连接列表已变化，请刷新。')
      this.save({ id, owner, name: input.name, url: url.toString(), revision: 1, secret, tools, automatic: [], connected: true })
      return { id }
    }
  }
  configure(owner: string, id: string, revision: number, automatic: string[]) {
    const c = this.get(owner, id)
    if (c.revision !== revision) throw new DeviceError('conflict', '连接已更新，请刷新。')
    if (automatic.some(name => !c.tools.some(tool => tool.name === name && tool.readOnly))) throw new DeviceError('invalid', '只有你选中的只读工具可以自动调用。')
    c.automatic = [...new Set(automatic)]; c.revision++; this.save(c); this.cancelConnection(id); return { id, revision: c.revision }
  }
  disconnect(owner: string, id: string, revision: number) {
    const c = this.get(owner, id)
    if (c.revision !== revision) throw new DeviceError('conflict', '连接已更新，请刷新。')
    c.connected = false; c.secret = ''; c.automatic = []; c.tools = []; c.revision++; this.save(c); this.cancelConnection(id); return { disconnected: true }
  }
  current(owner: string, id: string, revision: number, guard: () => void) {
    guard(); const c = this.get(owner, id)
    if (c.revision !== revision) throw new DeviceError('denied', 'MCP 连接或工具权限已经变化。')
    return c
  }
  source(id: string, revision: number) { return `mcp:${id}:${revision}` }
  async checkSource(owner: string, ref: string, guard: () => void): Promise<() => void> { return this.sourceCurrent(owner, ref, guard) }
  sourceCurrent(owner: string, ref: string, guard: () => void): () => void {
    const match = /^mcp:([0-9a-f-]{36}):(\d+)$/.exec(ref)
    if (!match) throw new DeviceError('denied', 'MCP 来源无效。')
    const check = () => { this.current(owner, match[1]!, Number(match[2]), guard) }
    check(); return check
  }
  async invoke(owner: string, id: string, name: string, args: Record<string, unknown>, requestKey: string, guard: () => void,
    confirm: (value: McpConfirmation) => Promise<boolean>) {
    const receipt = this.start(owner, id, name, args, requestKey, guard, confirm, new AbortController().signal)
    const operation = this.operations.get(receipt.id)
    await operation?.settled
    if (operation?.error) throw operation.error
    return this.read(owner, receipt.id, requestKey, guard, true)
  }

  /** Reserve once before any catalog request or confirmation. Only the real Run
   * owns the operation; ending a bounded HTTP wait does not cancel that Run. */
  start(owner: string, id: string, name: string, args: Record<string, unknown>, runId: string, guard: () => void,
    confirm: (value: McpConfirmation) => Promise<boolean>, runSignal: AbortSignal) {
    guard(); runSignal.throwIfAborted(); this.shutdown.signal.throwIfAborted()
    const c = this.get(owner, id), serialized = JSON.stringify(args)
    if (!runId.trim() || Buffer.byteLength(serialized) > 12000) throw new DeviceError('invalid', '工具参数过长或缺少运行身份，请缩小这次操作。')
    const argumentsSnapshot = canonical(JSON.parse(serialized)) as Record<string, unknown>
    const listed = c.tools.find(tool => tool.name === name)
    if (!listed) throw new DeviceError('invalid', '没有这个已连接的工具，请刷新连接。')
    const key = digest([owner, runId, id, c.revision, name, argumentsSnapshot])
    const legacyKey = digest([owner, runId, id, c.revision, name, args])
    const prior = this.d.db.prepare('SELECT id,record FROM personal_mcp_calls WHERE request_key IN (?,?) AND owner=?').get(key, legacyKey, owner)
    if (prior) {
      // Old synchronous receipts are already bound by their full request key.
      const record = JSON.parse(String(prior.record))
      if (!record.runId) this.d.db.prepare('UPDATE personal_mcp_calls SET record=? WHERE id=?').run(JSON.stringify({ ...record, runId }), String(prior.id))
      return this.read(owner, String(prior.id), runId, guard, true)
    }
    const callId = randomUUID(), record = { id: callId, runId, name: c.name, tool: name, at: (this.d.now ?? Date.now)() }
    this.d.db.prepare('INSERT INTO personal_mcp_calls VALUES(?,?,?,?,?,?,?)').run(callId, owner, id, c.revision, key, 'checking', JSON.stringify(record))
    const cancel = new AbortController(), signal = AbortSignal.any([runSignal, this.shutdown.signal, cancel.signal])
    const pinned = () => { signal.throwIfAborted(); this.current(owner, id, c.revision, guard) }
    const operation: McpOperation = { runId, owner, connectionId: id, cancel, pending: true, observed: false, assertCurrent: guard, settled: Promise.resolve() }
    const update = (state: string, extra: Record<string, unknown> = {}) => this.d.db.prepare('UPDATE personal_mcp_calls SET state=?,record=? WHERE id=?').run(state, JSON.stringify({ ...record, ...extra }), callId)
    this.operations.set(callId, operation)
    operation.settled = withoutRequestLease(async () => {
      let dispatched = false
      const checkCatalog = async () => {
        let fresh: RemoteTool[]
        try { fresh = await this.d.remote.tools(c.url, this.token(c), pinned) }
        catch { pinned(); throw new DeviceError('unavailable', '暂时无法核对 MCP 工具，未执行。') }
        pinned()
        if (digest(canonical(fresh.find(tool => tool.name === name))) !== digest(canonical(listed))) throw new DeviceError('conflict', 'MCP 工具说明已变化，请重新连接后检查权限。')
      }
      try {
        pinned(); await checkCatalog()
        if (!listed.readOnly || !c.automatic.includes(name)) {
          update('awaiting_confirmation')
          const accepted = await confirm({ name: c.name, url: c.url, tool: name, args: JSON.stringify(argumentsSnapshot), signal })
          pinned()
          if (!accepted) { update('declined'); return }
          // The remote catalog may have changed while the person was reading the card.
          await checkCatalog()
        }
        pinned(); update('running'); dispatched = true
        const result = await this.d.remote.call(c.url, this.token(c), name, argumentsSnapshot, pinned)
        pinned(); update(result.isError ? 'failed' : 'completed', { result: result.text })
      } catch (error) {
        operation.error = dispatched ? undefined : error
        update(dispatched ? 'uncertain' : signal.aborted ? 'cancelled' : 'failed',
          !dispatched && error instanceof DeviceError ? { note: error.message } : {})
      } finally { operation.pending = false }
    })
    return this.read(owner, callId, runId, guard, false)
  }

  private read(owner: string, callId: string, runId: string, guard: () => void, observe: boolean) {
    guard(); this.d.audience(owner)
    const row = this.d.db.prepare('SELECT connection_id,revision,state,record FROM personal_mcp_calls WHERE id=? AND owner=?').get(callId, owner)
    if (!row) throw new DeviceError('denied', '找不到本次工具调用。')
    const record = JSON.parse(String(row.record)), state = String(row.state)
    if (record.runId !== runId) throw new DeviceError('denied', '工具调用不属于当前运行。')
    this.current(owner, String(row.connection_id), Number(row.revision), guard)
    const operation = this.operations.get(callId)
    operation?.assertCurrent()
    if (observe && operation && !pendingStates.has(state)) operation.observed = true
    const note = record.note ?? (pendingStates.has(state) ? '已登记同一次调用。用 friday_wait_connected_tool 和这个 id 继续等待；不要重新发起，也不要将等待说成完成。'
      : state === 'uncertain' ? '未取得完整回执，操作可能已经执行。请到原服务核实，不要重复提交。'
      : state === 'declined' ? '用户未确认，工具没有执行。'
      : state === 'cancelled' ? '确认或原运行已结束，工具没有执行。' : '这是同一次调用的记录，没有重复执行。')
    return { id: callId, state, ...(operation && typeof record.result === 'string' ? { result: record.result } : {}), ref: this.source(String(row.connection_id), Number(row.revision)),
      note: !operation && typeof record.result === 'string' ? '调用已记录；原运行的资料权限核验已结束，这里仅提供状态。请回原工作查看已交付结果，不要重新执行。' : note }
  }
  async wait(owner: string, callId: string, runId: string, guard: () => void, timeoutMs = 20_000, signal?: AbortSignal) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 20_000) throw new DeviceError('invalid', '每次最多等待20秒。')
    signal?.throwIfAborted(); this.read(owner, callId, runId, guard, false)
    const operation = this.operations.get(callId)
    if (operation?.pending) await waitBounded(operation.settled, timeoutMs, signal)
    signal?.throwIfAborted()
    return this.read(owner, callId, runId, guard, true)
  }
  unobservedForRun(runId: string): string[] {
    return [...this.operations].filter(([, op]) => op.runId === runId && !op.observed).map(([id]) => id)
  }
  markUnobservedForRun(runId: string, callId: string): void {
    const operation = this.operations.get(callId)
    if (operation?.runId === runId) operation.observed = false
  }
  async settleRun(runId: string): Promise<void> {
    await Promise.all([...this.operations.values()].filter(op => op.runId === runId).map(op => op.settled))
  }
  cancelRun(runId: string): void {
    for (const [id, op] of this.operations) if (op.runId === runId) {
      op.cancel.abort(new Error('原运行已结束'))
      const release = () => { if (this.operations.get(id) === op) this.operations.delete(id) }
      void op.settled.then(release, release)
    }
  }
  private cancelConnection(id: string): void {
    for (const op of this.operations.values()) if (op.connectionId === id) op.cancel.abort(new Error('MCP 连接已变化'))
  }
  beginShutdown(): void { this.shutdown.abort(new Error('工具服务正在重启')) }
  async waitForShutdown(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    await waitBounded(Promise.all([...this.operations.values()].map(op => op.settled)).then(() => undefined), timeoutMs)
    const pending = [...this.operations.values()].filter(op => op.pending).length
    return { drained: pending === 0, pending }
  }
  calls(owner: string) {
    this.d.audience(owner)
    return this.d.db.prepare('SELECT connection_id,revision,state,record FROM personal_mcp_calls WHERE owner=? ORDER BY rowid DESC LIMIT 30').all(owner).flatMap(row => {
      try {
        this.current(owner, String(row.connection_id), Number(row.revision), () => {})
        const record = JSON.parse(String(row.record))
        // These receipts do not retain the source permissions of the arguments.
        // A current MCP connection alone cannot authorize an old result body.
        return [{ id: record.id, name: record.name, tool: record.tool, at: record.at, state: row.state }]
      }
      catch { return [] }
    })
  }
}
