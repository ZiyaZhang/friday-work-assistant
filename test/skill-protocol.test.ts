import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { DeliveryService } from '../src/core/delivery.js'
import { SkillApplication } from '../src/core/skill-application.js'
import { SkillProposals } from '../src/core/skills.js'
import { BuiltinSkillReader, prepareBuiltinSkillBundle } from '../src/core/builtin-skill-bundle.js'
import { createInternalApi } from '../src/internal/api.js'
import { ALL_SCOPES, TokenIssuer, type Capability } from '../src/internal/tokens.js'
import { buildServer } from '../src/mcp/server.js'
import { createLogger } from '../src/log.js'
import { spaceDeps } from './helpers/space.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { memoryRuntimeFixture } from './helpers/memory-runtime.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const input = { name: 'protocol-flow', description: 'A synthetic repeatable procedure',
  body: 'Check the original supplied source, preserve the evidence, and report the actual result with links. '.repeat(2) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

/** Real MCP, HTTP, stores and Delivery; current-Run resolution and Feishu transport are explicit fixtures. */
async function setup(options: { pinnedBuiltinDigest?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'friday-builtin-protocol-')), source = join(root, 'source')
  mkdirSync(join(source, 'evidence-review', 'references'), { recursive: true })
  writeFileSync(join(source, 'evidence-review', 'SKILL.md'), '---\nname: evidence-review\ndescription: Read actual evidence\n---\nUse the supplied references.')
  writeFileSync(join(source, 'evidence-review', 'references', 'details.md'), 'PINNED_REFERENCE_CANARY')
  const bundle = prepareBuiltinSkillBundle(source, join(root, 'bundles'))
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }) })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), skills = new SkillProposals(registry.db)
  const memoryHost = memoryRuntimeFixture(registry, memory)
  memoryHost.pin({ runId: 'run-a', sessionKey: 'session-a', actorOpenId: 'alice' })
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const cache = new MessageCache(registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  const tokens = new TokenIssuer('synthetic-secret'), log = createLogger('skill-protocol', 'error')
  const cap: Capability = { sessionKey: 'session-a', runId: 'run-a', requesterOpenId: 'alice',
    chatId: 'chat-a', chatType: 'group', spaceId: space.id, scopes: [...ALL_SCOPES], exp: 9999999999 }
  const seed = skills.propose({ ...input, name: 'seed-flow', spaceId: space.id, sessionKey: 'seed-session', chatId: 'chat-a', chatType: 'group', proposerOpenId: 'alice', originRunId: 'seed-run' })
  skills.accept(seed.id, 'Alice', 'alice')
  skills.pinForRun({ runId: cap.runId!, spaceId: space.id, builtinDigest: options.pinnedBuiltinDigest ?? bundle.digest })
  const state = { currentRunId: 'run-a', routes: undefined as string[] | undefined, failPatch: false }
  let afterPost: (() => Promise<void>) | undefined
  const app = new SkillApplication(registry.db, { skills, ...sp,
    resolveRun: ref => state.currentRunId === ref.runId && ref.sessionKey === cap.sessionKey ? { ...ref,
      spaceId: space.id, chatId: 'chat-a', chatType: 'group', requesterOpenId: 'alice' } : undefined,
    userName: async () => 'Alice', stopRuns: () => [],
    patchCard: async (id, card) => { if (state.failPatch) throw new Error('synthetic patch ACK lost'); await feishu.patchCard(id, card) },
    deliveryFor: () => new DeliveryService(registry.db, { ...sp,
      resolveContext: async () => ({ actorOpenId: 'alice', provenanceComplete: true, expiresAt: Date.now() + 60_000,
        sources: [{ ref: 'trusted-origin', spaceId: space.id, chatId: 'chat-a' }],
        audience: { kind: 'group', spaceId: space.id, chatId: 'chat-a', replyToMessageId: 'origin' } }),
      send: async ({ payload }) => {
        const sent = 'card' in payload ? await feishu.replyCard('origin', payload.card)
          : await feishu.replyText('origin', payload.text)
        if ('card' in payload) await afterPost?.()
        return { remoteId: sent.messageId }
      },
    }),
  })
  const propose = vi.fn((key: string, runId: string, value: typeof input) => app.propose({ sessionKey: key, runId }, value))
  const disable = vi.fn(async () => { throw new Error('must not enter disable') })
  const api = createInternalApi({ registry, memory, memoryRuntime: memoryHost.runtime, skills, builtinSkills: new BuiltinSkillReader(bundle), ...sp, feishu, messageCache: cache,
    messages: new MessageService(feishu, cache, log), todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 10,
    proposeSkill: propose, disableSkill: disable,
    resolveActorForSession: () => ({ requesterOpenId: 'alice', runId: state.currentRunId, stage: 'task' }),
    allowedRoutesForSession: () => state.routes,
  })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  cleanup.push(async () => { await new Promise<void>(resolve => api.server.close(() => resolve())); registry.close() })
  const post = (path: string, body: Record<string, unknown>, override: Partial<Capability> = {}) => fetch(`${base}/v1/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.issue({ ...cap, ...override })}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const mcp = async () => {
    const server = buildServer({ apiUrl: base, token: tokens.issue(cap) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'skill-protocol-fixture', version: '1' })
    await client.connect(clientTransport)
    cleanup.push(async () => { await client.close(); await server.close() })
    return client
  }
  const decide = (id: number, decision: 'accept' | 'ignore') => app.decide({ proposalId: id, decision,
    operatorOpenId: 'alice', chatId: 'chat-a', contentDigest: skills.get(id)?.contentDigest ?? undefined,
    messageId: fake.of('replyCard').at(-1)?.messageId })
  return { registry, memory, skills, space, cap, seed, app, fake, state, propose, disable, post, mcp, bundle, decide,
    afterPost: (callback: () => Promise<void>) => { afterPost = callback } }
}

describe('skill HTTP and MCP contracts', () => {
  it('serves pinned builtin methods and references through the same signed MCP without native file access', async () => {
    const t = await setup(), client = await t.mcp()
    const catalog = await client.callTool({ name: 'friday_list_skills', arguments: {} })
    expect(catalog.isError).not.toBe(true)
    expect(JSON.stringify(catalog.content)).toContain('evidence-review')
    expect(JSON.stringify(catalog.content)).toContain('references/details.md')
    const loaded = await client.callTool({ name: 'friday_load_skill', arguments: { source: 'builtin', name: 'evidence-review', resource: 'references/details.md' } })
    expect(loaded.isError).not.toBe(true)
    expect(JSON.stringify(loaded.content)).toContain('PINNED_REFERENCE_CANARY')
    expect(JSON.stringify(loaded.content)).toContain(t.bundle.digest)
    expect(JSON.stringify(loaded.content)).not.toContain(t.bundle.directory)
    const custom = await client.callTool({ name: 'friday_load_skill', arguments: { name: t.seed.name, proposal_id: t.seed.id } })
    expect(custom.isError).not.toBe(true)
    expect(t.fake.sent).toEqual([])
  })

  it('does not accept a model-supplied version in place of the actual Run pin', async () => {
    const t = await setup({ pinnedBuiltinDigest: 'other-bundle' })
    const result = await t.post('skill/load', { source: 'builtin', name: 'evidence-review', builtinDigest: t.bundle.digest })
    expect(result.status).toBe(409)
    expect(JSON.stringify(await result.json())).not.toContain('Use the supplied references')
    expect((await t.post('skill/list', {})).status).toBe(409)
  })

  it('rejects changed reference files and ambiguous or escaping resource selections', async () => {
    const t = await setup()
    for (const body of [
      { source: 'builtin', name: 'evidence-review', resource: '../secret' },
      { source: 'builtin', name: 'evidence-review', resource: '/etc/hosts' },
      { source: 'builtin', name: 'evidence-review', proposal_id: t.seed.id },
      { source: 'space', name: t.seed.name, proposal_id: t.seed.id, resource: 'references/details.md' },
    ]) expect((await t.post('skill/load', body)).status).toBe(400)
    writeFileSync(join(t.bundle.directory, 'evidence-review', 'references', 'details.md'), 'MUTATED_REFERENCE_CANARY')
    const result = await t.post('skill/load', { source: 'builtin', name: 'evidence-review' })
    expect(result.status).toBe(409)
    expect(JSON.stringify(await result.json())).not.toContain('MUTATED_REFERENCE_CANARY')
  })

  it('rechecks stop, phase and Space authority before builtin catalog or resource reads', async () => {
    const t = await setup(), body = { source: 'builtin', name: 'evidence-review' }
    t.state.routes = ['POST /v1/memory/search']
    expect((await t.post('skill/load', body)).status).toBe(403)
    t.state.routes = undefined
    expect((await t.post('skill/load', body, { scopes: ['memory:read'] })).status).toBe(403)
    t.state.currentRunId = 'run-after-stop'
    expect((await t.post('skill/list', {})).status).toBe(403)
    expect((await t.post('skill/load', body)).status).toBe(403)
    expect(t.fake.sent).toEqual([])
  })

  it('lets a consolidation token read its pinned catalog and body without widening token or phase scopes', async () => {
    const t = await setup()
    const policy = { memoryWritePolicy: { candidateIds: [] } }
    const listed = await t.post('skill/list', {}, policy)
    expect(listed.status).toBe(200)
    expect((await listed.json()).skills.map((s: { proposalId: number }) => s.proposalId)).toEqual([t.seed.id])
    const loaded = await t.post('skill/load', { name: t.seed.name, proposal_id: t.seed.id }, policy)
    expect(loaded.status).toBe(200)
    expect((await loaded.json()).content).toContain(input.body.trim())
    expect(t.skills.getRunSkillSet('run-a')?.served).toHaveLength(1)
    expect((await t.post('skill/list', {}, { ...policy, scopes: ['memory:read'] })).status).toBe(403)
    t.state.routes = ['POST /v1/memory/search']
    expect((await t.post('skill/load', { name: t.seed.name, proposal_id: t.seed.id }, policy)).status).toBe(403)
    t.state.routes = undefined
    t.state.currentRunId = 'run-new'
    expect((await t.post('skill/list', {}, policy)).status).toBe(403)
  })

  it('keeps proposal, disable and unrelated writes outside consolidation even when their scopes are signed', async () => {
    const t = await setup(), policy = { memoryWritePolicy: { candidateIds: [] } }
    for (const [path, body] of [['skill/propose', input], ['skill/disable', { name: t.seed.name, expected_revision: 1 }],
      ['todo/add', { title: 'must not create' }]] as const) {
      expect((await t.post(path, body, policy)).status).toBe(403)
    }
    expect(t.propose).not.toHaveBeenCalled()
    expect(t.disable).not.toHaveBeenCalled()
    expect(t.fake.sent).toHaveLength(0)
  })

  it('preserves the candidate write allowlist after skill reading succeeds', async () => {
    const t = await setup(), scope = `space:${t.space.id}`
    const candidate = t.memory.add({ scope, kind: 'fact', title: 'candidate', body: 'candidate value', status: 'candidate' })
    const confirmed = t.memory.add({ scope, kind: 'fact', title: 'confirmed', body: 'confirmed value', status: 'candidate' })
    t.memory.confirm(confirmed.id, scope, { by: 'alice', messageId: 'confirm-source' })
    const policy = { memoryWritePolicy: { candidateIds: [candidate.id, confirmed.id] } }
    expect((await t.post('skill/load', { name: t.seed.name, proposal_id: t.seed.id }, policy)).status).toBe(200)
    expect((await t.post('memory/save', { title: 'new', body: 'new unrelated value' }, policy)).status).toBe(403)
    expect((await t.post('memory/save', { title: 'new', body: 'replace confirmed', replaces: confirmed.id }, policy)).status).toBe(403)
    expect((await t.post('memory/save', { title: 'new', body: 'share candidate', replaces: candidate.id, share: 'org' }, policy)).status).toBe(403)
    expect((await t.post('memory/save', { title: 'new', body: 'correct candidate', replaces: candidate.id }, policy)).status).toBe(200)
    expect(t.memory.get(confirmed.id)).toMatchObject({ body: 'confirmed value', status: 'confirmed' })
  })

  it.each(['pending', 'accepted', 'ignored'] as const)('reports the real %s proposal state through MCP and HTTP', async decision => {
    const t = await setup(), client = await t.mcp(), visible = deferred(), ack = deferred()
    t.afterPost(async () => { visible.resolve(); await ack.promise })
    const request = client.callTool({ name: 'friday_propose_skill', arguments: input })
    await visible.promise
    const id = t.registry.db.prepare('SELECT id FROM skill_proposals WHERE name=?').get(input.name)!.id as number
    if (decision !== 'pending') await t.decide(id, decision === 'accepted' ? 'accept' : 'ignore')
    ack.resolve()
    const result = await request
    expect(result.isError).not.toBe(true)
    const rendered = JSON.stringify(result.content)
    if (decision === 'pending') expect(rendered).toContain('等用户在卡片上接受或忽略')
    else {
      expect(rendered).toContain(decision === 'accepted' ? '已接受' : '已忽略')
      expect(rendered).not.toContain('等用户')
    }
    const replay = await t.post('skill/propose', input)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ id, status: decision, card_status: decision === 'pending' ? 'not_sent' : 'updated', delivery_status: 'sent' })
    expect(t.fake.of('replyCard')).toHaveLength(1)
    expect(t.fake.of('replyText')).toHaveLength(1)
    expect(t.fake.of('replyText')[0]?.payload).toContain(input.body.trim())
  })

  it('reports a saved accepted decision separately from an unknown card patch', async () => {
    const t = await setup(), client = await t.mcp(), visible = deferred(), ack = deferred()
    t.afterPost(async () => { visible.resolve(); await ack.promise })
    const request = client.callTool({ name: 'friday_propose_skill', arguments: input })
    await visible.promise
    const id = t.registry.db.prepare('SELECT id FROM skill_proposals WHERE name=?').get(input.name)!.id as number
    await t.decide(id, 'accept')
    t.state.failPatch = true
    ack.resolve()
    const result = await request
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('已接受')
    expect(JSON.stringify(result.content)).toContain('卡片状态更新结果待核对，决定已保存')
    expect(JSON.stringify(result.content)).not.toContain('等用户')
    expect(await (await t.post('skill/propose', input)).json()).toMatchObject({ status: 'accepted', card_status: 'unknown', delivery_status: 'sent' })
    expect(t.fake.of('replyCard')).toHaveLength(1)
  })
})
