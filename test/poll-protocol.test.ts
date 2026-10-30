import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { pollRuntimeFixture } from './helpers/poll-runtime.js'
import { createPollRoutes } from '../src/internal/poll-routes.js'
import { registerPollTools } from '../src/mcp/poll-tools.js'
import { TokenIssuer, type Capability } from '../src/internal/tokens.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
/** Real SDK→signed HTTP→domain/Delivery/Feedback. The shared production API/host
 * assembly is deliberately not claimed by this independent adapter fixture. */
async function fixture() {
  const t = pollRuntimeFixture(), issuer = new TokenIssuer('synthetic-poll-protocol-signature')
  const error = (status: number, message: string) => Object.assign(new Error(message), { status })
  const assertCurrent = (cap: Capability) => {
    t.current()
    if (cap.runId !== t.run.id || cap.sessionKey !== t.run.sessionKey || cap.requesterOpenId !== 'alice' || cap.chatType !== 'group' ||
      cap.chatId !== t.group.chatId || cap.spaceId !== t.group.id || t.attempts.get(t.run.id)?.state !== 'running') throw error(403, 'Current original task Run required')
  }
  const routes = createPollRoutes({ runtime: t.runtime, requireRun(cap, scope) { assertCurrent(cap); if (!cap.scopes.includes(scope)) throw error(403, 'Missing poll scope'); return { runId: cap.runId!, sessionKey: cap.sessionKey } }, assertCurrent, error })
  const http = createServer(async (req, res) => {
    try {
      const cap = issuer.verify(req.headers.authorization?.replace(/^Bearer /, '') ?? '')
      if (!cap) throw error(401, 'Invalid capability')
      const handler = routes[`${req.method} ${req.url}`]; if (!handler) throw error(404, 'No model voting route')
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const result = await handler(cap, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } catch (e) { res.writeHead(Number((e as { status?: number }).status ?? 500), { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message })) }
  })
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  cleanups.push(async () => { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())) })
  const token = (override: Partial<Capability> = {}) => issuer.issue({ sessionKey: t.ref.sessionKey, runId: t.ref.runId, requesterOpenId: 'alice',
    spaceId: t.group.id, chatId: t.group.chatId!, chatType: 'group', scopes: ['polls:read', 'polls:write'], ...override })
  const post = (op: string, body: Record<string, unknown>, auth = token()) => fetch(`${base}/v1/polls/${op}`, {
    method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const server = new McpServer({ name: 'friday-poll-adapter-test', version: '1' }), client = new Client({ name: 'synthetic-model', version: '1' })
  registerPollTools(server, async (path, body) => {
    const response = await post(path.replace('/v1/polls/', ''), body), result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }, e => ({ isError: true, content: [{ type: 'text', text: (e as Error).message }] }))
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a)
  cleanups.push(async () => { await client.close(); await server.close() })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }); expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return JSON.parse((result.content as { text: string }[])[0]!.text)
  }
  return { ...t, client, call, post, token }
}

describe('independent poll MCP/HTTP protocol', () => {
  it('publishes complete choices, accepts real callbacks, reads actual names, closes and links feedback once', async () => {
    const t = await fixture()
    expect((await t.call('friday_list_polls')).polls).toEqual([])
    const created = await t.call('friday_create_poll', { ...t.input, closesAt: 0 })
    expect(created).toMatchObject({ published: true, closesAt: null })
    await t.vote(created.pollId, '1'); await t.vote(created.pollId, null, '2000000'); await t.vote(created.pollId, '2', '3000000')
    const read = await t.call('friday_read_poll', { pollId: created.pollId })
    expect(read.results[1]).toMatchObject({ count: 1, voters: [{ name: 'Bob' }] }); expect(read.total).toBe(1)
    expect(JSON.stringify(read)).not.toContain('voterOpenId'); expect(JSON.stringify(read)).not.toContain('context'); expect(JSON.stringify(read)).not.toContain('runId')
    const closed = await t.call('friday_close_poll', { pollId: created.pollId })
    expect(closed.resultDelivered).toBe(true); expect(t.bugs.get(closed.feedbackId)).toMatchObject({ intakePhase: 'triaged', issueUrl: null })
    await t.call('friday_close_poll', { pollId: created.pollId }); expect(t.bugs.reports(closed.feedbackId)).toHaveLength(1)
    expect(t.fake.sent.every(message => message.target === t.group.chatId)).toBe(true)
  })
  it('requires a signed current task with the actual scope and audience before reading or writing', async () => {
    const t = await fixture()
    expect((await t.post('list', {}, 'forged')).status).toBe(401)
    for (const patch of [{ runId: 'stale' }, { scopes: [] }, { chatId: 'foreign' }, { requesterOpenId: 'mallory' }, { chatType: 'p2p' as const }])
      expect((await t.post('create', t.input, t.token(patch))).status).toBe(403)
    expect(t.polls.list()).toEqual([]); expect(t.send).not.toHaveBeenCalled()
  })
  it('rejects model-supplied approval, actor or provenance and provides no model vote/withdraw route', async () => {
    const t = await fixture()
    for (const extra of [{ approved: true }, { origin: t.origin }, { operatorOpenId: 'bob' }, { provenance: t.context }, { eventId: 'forged' }])
      expect((await t.post('create', { ...t.input, ...extra })).status).toBe(400)
    const tools = await t.client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['friday_close_poll', 'friday_create_poll', 'friday_list_polls', 'friday_read_poll'])
    for (const op of ['vote', 'withdraw', 'decide']) expect((await t.post(op, { pollId: 'x', voter: 'bob' })).status).toBe(404)
    expect(t.send).not.toHaveBeenCalled()
  })
  it('surfaces unknown publication as failure and reuses its receipt rather than creating a second poll', async () => {
    const t = await fixture(); t.state.failSend = true
    const first = await t.client.callTool({ name: 'friday_create_poll', arguments: t.input }); t.state.failSend = false
    const again = await t.client.callTool({ name: 'friday_create_poll', arguments: t.input })
    expect(first.isError).toBe(true); expect(again.isError).toBe(true); expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.polls.list()).toHaveLength(1); expect(t.polls.list()[0]?.state).toBe('draft')
  })
})
