import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { FridayClient } from '../integrations/dsh/lib/transport.js'
import worker from '../cloudflare/friday-oauth/src/worker.js'
import { PersonalDevices } from '../src/personal/devices.js'
import { PersonalDesktopBridge } from '../src/personal/desktop-bridge.js'
import { PersonalDesktopApplication } from '../src/personal/desktop-application.js'
import { PersonalApplication } from '../src/core/personal-application.js'
import { PersonalCollectionStore } from '../src/core/personal-collection.js'
import { PersonalAssistance } from '../src/core/personal-assistance.js'
import { Registry } from '../src/core/registry.js'
import { Spaces } from '../src/core/space.js'
import { PolicyService } from '../src/core/policy.js'
import { Todos } from '../src/core/todos.js'
import { TodoApplication } from '../src/core/todo-application.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { PersonalResults } from '../src/personal/results.js'
import { gmailFixture } from './helpers/gmail.js'
import { PersonalLocalWork } from '../src/personal/local-work.js'
import { PersonalMcpConnections } from '../src/personal/mcp-connections.js'
import { deviceEnvelopePurpose, sealDevice } from '../src/personal/device-crypto.js'

const TOKEN = 'synthetic-desktop-integration-relay', BASE = 'https://friday.test'
const cleanups: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).reverse().forEach(fn => fn()) })
async function fixture() {
  const registry = new Registry(':memory:'), db = new DatabaseSync(':memory:'), directory = mkdtempSync(join(tmpdir(), 'friday-desktop-'))
  new RunAttempts(registry.db)
  cleanups.push(() => { registry.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  db.exec(readFileSync(new URL('../cloudflare/friday-oauth/schema.sql', import.meta.url), 'utf8'))
  const env = { RELAY_TOKEN: TOKEN, DB: { prepare(sql: string) {
    let args: unknown[] = []
    const statement = { bind(...a: unknown[]) { args = a; return statement },
      async run() { return { results: db.prepare(sql).all(...args as never[]) } },
      async first() { return db.prepare(sql).get(...args as never[]) },
      async all() { return { results: db.prepare(sql).all(...args as never[]) } } }
    return statement
  } } }
  const fetch = (async (url: string, input?: RequestInit) => worker.fetch(new Request(url, input), env)) as typeof globalThis.fetch
  const spaces = new Spaces(registry.db), policy = new PolicyService(spaces, { admins: [] }), todos = new Todos(registry.db)
  spaces.ensure({ kind: 'p2p', openId: 'alice', chatId: 'alice-dm' }); spaces.ensure({ kind: 'p2p', openId: 'bob', chatId: 'bob-dm' })
  const collection = new PersonalCollectionStore(registry.db, todos), todoApplication = new TodoApplication({ db: registry.db, todos })
  const application = new PersonalApplication({ registry, spaces, policy, todos, collection, application: todoApplication,
    readScope: new ChatReadScope(registry.db), controls: {} as never, now: Date.now, assertActive() {},
    userTokens: { get: () => undefined, isConnected: () => false, grantId: () => null, begin: () => 'unused' }, authorizeUrl: () => 'https://example.test' })
  const assistance = new PersonalAssistance({ registry, todos, now: Date.now, audience: owner => application.audience(owner), readable: () => false,
    canReadPr: () => false, createSession: () => { throw new Error('No offer in this test') } })
  const authorize = vi.fn(async (_value: unknown, guard: () => void) => ({ status: 'allowed' as const, assertCurrent: guard }))
  const results = new PersonalResults(registry.db, authorize)
  const gmail = await gmailFixture(true, registry.db), jobs: Promise<void>[] = []
  const devices = new PersonalDevices({ db: registry.db, encryptionKey: Buffer.alloc(32, 3), relayToken: TOKEN, baseUrl: BASE,
    lifetimeMs: 86_400_000, assertOwner: owner => { application.audience(owner) } })
  const localWork = new PersonalLocalWork({ db: registry.db, devices, results, now: Date.now, audience: owner => application.audience(owner) })
  const remote = { tools: vi.fn(async () => [{ name: 'lookup', inputSchema: { type: 'object' }, readOnly: true }]),
    call: vi.fn(async () => ({ text: 'synthetic result', isError: false })) }
  const personalMcp = new PersonalMcpConnections({ db: registry.db, key: Buffer.alloc(32, 5), remote, audience: owner => application.audience(owner) })
  const domain = new PersonalDesktopApplication({ application, registry, todos, collection, assistance, results, now: Date.now, dispatch: vi.fn(), changed: vi.fn(),
    localWork, localChanged: vi.fn(), personalMcp, gmail: gmail.connections,
    emailDrafts: gmail.drafts, emailChanged: vi.fn(async () => {}), background: work => { jobs.push(work()) } })
  const changed = vi.fn(async () => {}), bridge = new PersonalDesktopBridge({ devices, baseUrl: BASE, token: TOKEN, fetch, enabled: () => true,
    changed, prepare: (owner, request, guard) => domain.prepare(owner, request, guard), execute: (actor, input, id) => domain.execute(actor, input, id), afterCommit: () => domain.afterCommit(), afterRollback: () => domain.discardEffects(), warn: vi.fn() })
  const client = new FridayClient({ directory, fetch, relay: BASE })
  cleanups.push(() => { bridge.close(); client.close() })
  const connect = async () => {
    const link = devices.begin('alice')
    await client.pair(link.url, 'Alice Mac'); await bridge.tick()
    const pending = devices.pendingFor('alice')!
    expect(pending.status).toBe('requested'); expect(changed).toHaveBeenCalledWith('alice')
    devices.approve('alice', pending.state, pending.requestHash!)
    await bridge.tick(); await client.finishPair()
    expect(client.status().state).toBe('connected')
    expect(statSync(join(directory, 'connection.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(client.status())).not.toMatch(/ticket|key/)
  }
  const call = async (command: unknown, id = randomUUID()) => {
    const pending = client.request(id, command)
    // A real encrypted request has reached the relay before the production host processes it.
    await vi.waitFor(() => expect(db.prepare('SELECT 1 FROM desktop_requests WHERE request_id=?').get(id)).toBeTruthy())
    await bridge.tick(); return pending
  }
  const add = (owner: string) => todoApplication.create(application.audience(owner), { title: owner + ' task', ownerOpenId: owner }, owner).todo
  return { client, bridge, devices, application, registry, todos, add, connect, call, db, directory, changed, results, authorize, domain, gmail, jobs, localWork, personalMcp, remote }
}
describe('DSH to the same Friday personal application', () => {
  it('waits for a slow read using the same encrypted request and receipt', async () => {
    const t = await fixture(); await t.connect(); t.add('alice')
    vi.useFakeTimers()
    t.client.now = () => Date.now()
    const requestId = randomUUID()
    const start = Date.now(), connection = t.client.read('connection')
    const post = vi.spyOn(t.client, 'post').mockImplementation(async () => Date.now() - start < 35_000 ? { state: 'pending' } : {
      payload: sealDevice(Buffer.from(connection.key, 'base64url'), { items: [{ title: 'alice task' }] }, deviceEnvelopePurpose(connection.id, requestId, 'response')),
    })
    const pending = t.client.request(requestId, { operation: 'list' })
    await vi.advanceTimersByTimeAsync(36_000)
    expect(await pending).toMatchObject({ items: [{ title: 'alice task' }] })
    expect(post.mock.calls.filter(([path]) => path === 'request')).toHaveLength(1)
    expect(post.mock.calls.every(([, input]) => input.requestId === requestId)).toBe(true)
    expect(t.client.status().state).toBe('connected')
  })
  it('bounds an unavailable relay receipt without expiring the device or resubmitting', async () => {
    const t = await fixture(); await t.connect()
    vi.useFakeTimers()
    t.client.now = () => Date.now()
    const post = vi.spyOn(t.client, 'post').mockResolvedValue({ state: 'pending' })
    const pending = t.client.request(randomUUID(), { operation: 'list' })
    const rejected = expect(pending).rejects.toThrow('暂未收到 Friday 的结果')
    await vi.advanceTimersByTimeAsync(61_000)
    await rejected
    expect(post.mock.calls.filter(([path]) => path === 'request')).toHaveLength(1)
    expect(t.client.status().state).toBe('connected')
  })
  it('manages only the paired owner’s accounts and MCP tools without storing a plaintext credential in the relay', async () => {
    const t = await fixture(); await t.connect()
    const account = await t.call({ operation: 'account-list' }) as any
    expect(account.gmail).toMatchObject({ available: true, status: 'connected', email: 'alice@example.com' })
    const created = await t.call({ operation: 'mcp-connect', name: 'Research', url: 'https://mcp.example.com/mcp', token: 'synthetic-personal-mcp-key' }) as any
    const list = await t.call({ operation: 'mcp-list' }) as any
    expect(list.connections).toMatchObject([{ id: created.id, name: 'Research', automatic: [], revision: 1 }])
    expect(JSON.stringify(list)).not.toContain('synthetic-personal-mcp-key')
    const read = t.personalMcp.sourceCurrent('alice', t.personalMcp.source(created.id, 1), () => {})
    expect(t.personalMcp.list('bob')).toHaveLength(0)
    await t.call({ operation: 'mcp-configure', id: created.id, revision: 1, automatic: ['lookup'] })
    expect(read).toThrow('已经变化')
    expect(() => t.personalMcp.disconnect('bob', created.id, 2)).toThrow()
    const fresh = t.personalMcp.sourceCurrent('alice', t.personalMcp.source(created.id, 2), () => {})
    await t.call({ operation: 'mcp-disconnect', id: created.id, revision: 2 })
    expect(fresh).toThrow('已断开')
    expect(t.personalMcp.list('alice')[0]?.connected).toBe(false)
    const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    for (const { name } of tables) expect(JSON.stringify(t.db.prepare(`SELECT * FROM ${name}`).all())).not.toContain('synthetic-personal-mcp-key')
    expect(JSON.stringify(t.registry.db.prepare('SELECT * FROM personal_device_operations').all())).not.toContain('synthetic-personal-mcp-key')
    await expect(t.call({ operation: 'account-list', owner: 'bob' })).rejects.toThrow()
    await t.call({ operation: 'account-disconnect', provider: 'gmail', revision: account.gmail.revision })
    expect(t.gmail.connections.view('alice').status).not.toBe('connected')
    expect(t.remote.call).not.toHaveBeenCalled()
  })
  it('claims a local attempt once, honors a Feishu stop, and keeps local context off mutation receipts', async () => {
    const t = await fixture(); await t.connect()
    t.results.save({ body: '[Review background](https://github.com/example/repo/pull/7)', provenance: { sources: {}, memoryRefs: [] },
      origin: { taskId: 7, ownerOpenId: 'alice', spaceId: 'sp_dm_alice', chatType: 'p2p' } } as any, Date.now())
    const created = await t.call({ operation: 'local-create', text: 'Review on my machine.', sourceTaskId: 7 }) as any
    const readId = randomUUID(), preview = await t.call({ operation: 'local-get', id: created.id }, readId) as any
    expect(preview).toMatchObject({ state: 'queued', material: expect.stringContaining('Review background') })
    expect(t.registry.db.prepare('SELECT result FROM personal_device_operations WHERE request_id=?').get(readId)?.result).toBeNull()
    const claimId = randomUUID(), claim = { operation: 'local-claim', id: created.id, revision: 1, fingerprint: preview.fingerprint,
      attempt: randomUUID(), sessionId: randomUUID(), directory: '/synthetic/repo', model: 'current / model' }
    const claimed = await t.call(claim, claimId)
    expect(await t.client.request(claimId, claim)).toEqual(claimed)
    expect(t.localWork.get('alice', created.id)).toMatchObject({ state: 'running', revision: 2 })
    t.localWork.stop('alice', created.id, 2)
    expect(await t.call({ operation: 'local-event', id: created.id, attempt: claim.attempt, state: 'completed', body: 'Late result.' })).toMatchObject({ state: 'stopped' })
    expect(t.localWork.get('alice', created.id).result).toBeUndefined()
  })
  it('recovers the same device after an offline first pairing request', async () => {
    const t = await fixture(), link = t.devices.begin('alice'), original = t.client.fetch
    t.client.fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(original)
    await expect(t.client.pair(link.url, 'Alice Mac')).rejects.toThrow('连不上')
    const fingerprint = t.client.status().fingerprint
    expect(t.db.prepare('SELECT count(*) n FROM desktop_pairs').get()?.n).toBe(0)
    await t.client.finishPair(); await t.bridge.tick()
    const pending = t.devices.pendingFor('alice')!
    expect(pending.fingerprint).toBe(fingerprint)
    t.devices.approve('alice', pending.state, pending.requestHash!)
    await t.bridge.tick(); await t.client.finishPair()
    expect(t.client.status().state).toBe('connected')
    expect(t.devices.list('alice')).toHaveLength(1)
  })
  it('pairs through the real encrypted relay, reads only its owner, and updates the exact list Feishu uses', async () => {
    const t = await fixture(), alice = t.add('alice'), bob = t.add('bob')
    await t.connect()
    const list = await t.call({ operation: 'list' }) as any
    expect(list.items.map((item: any) => item.id)).toEqual([alice.id])
    const version = list.items[0].version
    expect(await t.call({ operation: 'item', id: alice.id, version, action: 'done' })).toEqual({ ok: true })
    expect(t.application.query('alice', 'closed').items.map(item => item.id)).toEqual([alice.id])
    expect(t.todos.get(bob.id)?.status).toBe('open')
    const original = t.todos.get(alice.id)
    await expect(t.call({ operation: 'item', id: alice.id, version, action: 'ignore' })).rejects.toThrow()
    expect(t.todos.get(alice.id)).toEqual(original)
    await expect(t.call({ operation: 'item', id: bob.id, version: t.application.itemVersion('bob', t.todos.get(bob.id)!), action: 'done' })).rejects.toThrow()
    expect(t.todos.get(bob.id)?.status).toBe('open')
  })
  it('returns one mutation receipt on duplicate requests and atomically revokes its own device', async () => {
    const t = await fixture(), todo = t.add('alice'); await t.connect()
    const command = { operation: 'item', id: todo.id, version: t.application.itemVersion('alice', todo), action: 'done' }, id = randomUUID()
    await t.call(command, id)
    expect(await t.client.request(id, command)).toEqual({ ok: true })
    expect(t.registry.db.prepare('SELECT count(*) n FROM personal_device_operations WHERE request_id=?').get(id)?.n).toBe(1)
    await expect(t.client.request(id, { ...command, action: 'ignore' })).rejects.toThrow('同一个操作')
    expect(await t.call({ operation: 'disconnect' })).toEqual({ disconnected: true })
    expect(t.client.status().state).toBe('disconnected')
    expect(t.devices.list('alice')[0]?.revokedAt).not.toBeNull()
  })
  it('retries a failed pairing card delivery and invalidates the desktop when revoked remotely', async () => {
    const t = await fixture(), link = t.devices.begin('alice')
    t.changed.mockRejectedValueOnce(new Error('Temporary Feishu failure'))
    await t.client.pair(link.url, 'Alice Mac'); await t.bridge.tick()
    expect(t.devices.pendingFor('alice')?.status).toBe('requested')
    await t.bridge.tick(); expect(t.changed).toHaveBeenCalledTimes(2)
    const pending = t.devices.pendingFor('alice')!
    t.devices.approve('alice', pending.state, pending.requestHash!); await t.bridge.tick(); await t.client.finishPair()
    const device = t.devices.list('alice')[0]!
    t.devices.revoke('alice', device.id, device.revision)
    await expect(t.call({ operation: 'list' })).rejects.toThrow('已失效')
    expect(t.client.status().state).toBe('expired')
  })
  it('revalidates saved result sources even for a replay and never returns another owner’s result', async () => {
    const t = await fixture(); await t.connect()
    const saved = { body: 'Only the final useful answer.', provenance: { sources: {}, memoryRefs: [] },
      origin: { taskId: 1, ownerOpenId: 'alice', spaceId: 'sp_dm_alice', chatType: 'p2p' } } as any
    const answerAt = Date.now(); t.results.save(saved, answerAt)
    const id = randomUUID(), command = { operation: 'result', taskId: 1 }
    expect(await t.call(command, id)).toEqual({ body: saved.body, taskId: 1, answerAt, resultVersion: t.results.metadata('alice', 1)!.version })
    t.results.save({ ...saved, body: 'Bob only', origin: { ...saved.origin, taskId: 2, ownerOpenId: 'bob', spaceId: 'sp_dm_bob' } }, Date.now())
    await expect(t.call({ operation: 'result', taskId: 2 })).rejects.toThrow('当前连接')
    // The public relay retains an encrypted receipt briefly. A fresh command
    // always rechecks source access; the host's own replay path does too.
    t.authorize.mockImplementation(async () => { throw new Error('Source revoked') })
    await expect(t.call(command)).rejects.toThrow()
    const input = t.client.read('request-' + id), connection = t.client.read('connection')
    const admitted = t.devices.prepare(connection.ticket, id, input.payload)
    await expect(t.domain.prepare(admitted.owner, admitted.request, admitted.assertCurrent)).rejects.toThrow('Source revoked')
  })
  it('pages a large Chinese result within the encrypted relay limit without losing content', async () => {
    const t = await fixture(); await t.connect()
    const body = '结果与来源'.repeat(30_000)
    t.results.save({ body, provenance: { sources: {}, memoryRefs: [] }, origin: {
      taskId: 1, ownerOpenId: 'alice', spaceId: 'sp_dm_alice', chatType: 'p2p' } } as any, Date.now())
    let combined = '', offset = 0
    do {
      const page = await t.call({ operation: 'result', taskId: 1, offset }) as any
      combined += page.body; offset = page.nextOffset ?? 0
    } while (offset)
    expect(combined).toBe(body)
  })
  it('edits and explicitly sends the same email draft through the encrypted device route', async () => {
    const t = await fixture(), draft = await t.gmail.reply(); await t.connect()
    const listId = randomUUID()
    const list = await t.call({ operation: 'email-list' }, listId) as any
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: draft.id, body: draft.body, revision: 1 })
    expect(t.registry.db.prepare('SELECT result FROM personal_device_operations WHERE request_id=?').get(listId)?.result).toBeNull()
    await t.call({ operation: 'email-edit', id: draft.id, revision: 1, to: draft.to, subject: draft.subject, body: 'The same revised draft.' })
    expect(t.gmail.drafts.get('alice', draft.id)).toMatchObject({ body: 'The same revised draft.', revision: 2 })
    expect(t.gmail.calls.filter(c => c.path === '/messages/send')).toHaveLength(0)
    await expect(t.call({ operation: 'email-action', id: draft.id, revision: 1, action: 'send' })).rejects.toThrow('更新')
    const id = randomUUID(), send = { operation: 'email-action', id: draft.id, revision: 2, action: 'send' }
    await t.call(send, id); await Promise.all(t.jobs.splice(0))
    expect(t.gmail.drafts.get('alice', draft.id).state).toBe('sent')
    await t.client.request(id, send)
    expect(t.gmail.calls.filter(c => c.path === '/messages/send')).toHaveLength(1)
    expect(await t.call({ operation: 'email-get', id: draft.id })).toMatchObject({ state: 'sent', url: expect.stringContaining('#all/abc') })
    t.gmail.connections.disconnect('alice', t.gmail.connections.view('alice').revision)
    await expect(t.call({ operation: 'email-get', id: draft.id })).rejects.toThrow()
    expect(await t.call({ operation: 'email-list' })).toMatchObject({ items: [] })
  })
})
