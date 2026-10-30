import type { AddressInfo } from 'node:net'
import { createInternalApi } from '../src/internal/api.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Todos } from '../src/core/todos.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { SkillProposals } from '../src/core/skills.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'friday-skill-runtime-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FRIDAY_HOME: home, FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), skills = new SkillProposals(registry.db)
  const sp = spaceDeps(registry.db), space = sp.spaces.ensure({ kind: 'group', chatId: 'chat-a', openId: 'alice' })
  const feishu = new FakeFeishu(), fake = createFakeAgent({ script: [{ kind: 'text', text: '查到了。' }] })
  feishu.threadIdForReply = 'thread-a'
  feishu.members.set('chat-a', new Set(['alice']))
  const tokens = new TokenIssuer('fixture'), log = createLogger('skill-runtime', 'error')
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: fake.app }, log,
    onPermission: (req, signal) => orchestrator.handlePermission(req, signal) })
  orchestrator = new Orchestrator({ cfg, registry, memory, skills, builtinSkillDigest: 'builtin-fixture', ...sp,
    ingressClassifier: { classify: async input => {
      const target = input.candidates.find(candidate => candidate.ref === input.message.replyToRef)
      return target ? { kind: 'amend', targetRef: target.ref } : { kind: 'work_request' }
    } },
    feishu: asFeishuClient(feishu), runtime, tokens, log, botOpenId: 'bot', apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  const cache = new MessageCache(registry.db), messages = new MessageService(asFeishuClient(feishu), cache, log)
  const api = createInternalApi({ registry, memory, skills, ...sp, feishu: asFeishuClient(feishu), messages, messageCache: cache,
    todos: new Todos(registry.db), tokens, log, maxHistoryPerCall: 50,
    resolveActorForSession: key => orchestrator.resolveActorForSession(key),
    allowedRoutesForSession: key => orchestrator.allowedRoutesForSession(key),
    canPersistDerivedState: key => orchestrator.canPersistDerivedState(key),
    proposeSkill: (key, runId, input) => orchestrator.proposeSkill(key, runId, input),
    disableSkill: (key, runId, input) => orchestrator.disableSkill(key, runId, input) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  let count = 0
  const message = (): InboundMessage => ({ eventId: `event-${++count}`, messageId: `message-${count}`, chatId: 'chat-a', chatType: 'group',
    msgType: 'text', senderType: 'user', senderOpenId: 'alice', mentions: [{ key: '@bot', openId: 'bot', name: 'Friday' }],
    text: count === 1 ? '帮我看一下这里' : '继续刚才的事', createTimeMs: Date.now(), ...(count > 1 ? { rootId: 'message-1', parentId: `message-${count - 1}`, threadId: 'thread-a' } : {}) })
  const accept = (body: string) => {
    const p = skills.propose({ name: 'my-workflow', description: '本空间的核查流程', body: body.repeat(12),
      sessionKey: 'msg:message-1', chatId: 'chat-a', chatType: 'group', spaceId: space.id, proposerOpenId: 'alice', originRunId: 'proposal-fixture' })
    skills.accept(p.id, 'Alice', 'alice'); return p
  }
  cleanups.push(async () => { await new Promise<void>(resolve => api.server.close(() => resolve())); await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const cap = () => {
    const prompt = fake.state.allPrompts.at(-1)!
    const mcp = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return tokens.verify(mcp[0]!.env.find(e => e.name === 'FRIDAY_CAP_TOKEN')!.value)!
  }
  const request = (path: string, body: unknown, capability = cap()) => fetch(url + path, { method: 'POST', headers: { authorization: `Bearer ${tokens.issue(capability)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { registry, memory, skills, space, feishu, runtime, orchestrator, fake, message, accept, cap, request, ...sp }
}

describe('space skill wiring through host Run and ACP', () => {
  it('pins catalog per Run, resumes identical versions and rotates physical history after a binding update', async () => {
    const t = await setup(), firstVersion = t.accept('先核对原消息。')
    await t.orchestrator.handleMessage(t.message())
    const first = t.cap(), firstSet = t.skills.getRunSkillSet(first.runId!)!
    expect(firstSet.skills.map(s => s.proposalId)).toEqual([firstVersion.id])
    expect(t.fake.state.allPrompts.at(-1)!.text).toContain('friday_load_skill')
    // A catalog is not proof that the model loaded it.
    expect(firstSet.served).toEqual([])
    await t.orchestrator.handleMessage(t.message())
    expect(t.fake.state.resumed).toEqual(['fake-session-1'])
    const secondVersion = t.accept('先核对修订消息。')
    await t.orchestrator.handleMessage(t.message())
    const third = t.cap()
    expect(t.fake.state.allPrompts.at(-1)!.sessionId).toBe('fake-session-2')
    expect(t.fake.state.resumed).toEqual(['fake-session-1'])
    expect(t.skills.getRunSkillSet(third.runId!)!.skills.map(s => s.proposalId)).toEqual([secondVersion.id])
    expect(t.skills.getRunSkillSet(first.runId!)!.skills.map(s => s.proposalId)).toEqual([firstVersion.id])
    expect(third.sessionKey).toBe(first.sessionKey)
    expect(new Set([1, 2, 3].map(id => t.registry.taskWork.get(id)?.key)).size).toBe(1)
  })

  it('retires a legacy ACP handle whose skill history was never recorded', async () => {
    const t = await setup()
    await t.orchestrator.handleMessage(t.message())
    const first = t.cap()
    t.registry.db.prepare('DELETE FROM kv WHERE k = ?').run(`runtime-skills:${first.sessionKey}`)
    await t.orchestrator.handleMessage(t.message())
    expect(t.fake.state.allPrompts.at(-1)!.sessionId).toBe('fake-session-2')
    expect(t.fake.state.resumed).toEqual([])
    expect(t.registry.taskWork.get(2)?.key).toBe(t.registry.taskWork.get(1)?.key)
  })

  it('invalidates host identity immediately after a skill pin is disabled', async () => {
    const t = await setup(), p = t.accept('这是一条原始流程。')
    let before: unknown, after: unknown
    t.fake.state.script = [{ kind: 'hook', run: () => {
      const cap = t.cap()
      before = t.orchestrator.resolveActorForSession(cap.sessionKey)
      t.skills.disable(t.space.id, p.name, 1, 'alice')
      after = t.orchestrator.resolveActorForSession(cap.sessionKey)
    } }, { kind: 'text', text: 'INVALIDATED_MODEL_FINAL' }]
    await t.orchestrator.handleMessage(t.message())
    expect(before).toBeTruthy(); expect(after).toBeUndefined()
    expect(JSON.stringify(t.feishu.sent)).not.toContain('INVALIDATED_MODEL_FINAL')
  })
  it('uses the real HTTP current-run gate for pinned loads and rejects a foreign or ended Run', async () => {
    const t = await setup(), p = t.accept('本空间的已接受方法。')
    let captured: ReturnType<typeof t.cap> | undefined
    t.fake.state.script = [{ kind: 'hook', run: async () => {
      captured = t.cap()
      const response = await t.request('/v1/skill/load', { name: p.name, proposal_id: p.id })
      expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).toContain('本空间的已接受方法')
      const otherSpace = t.spaces.ensure({ kind: 'group', chatId: 'chat-b', openId: 'bob' })
      const other = t.skills.propose({ name: p.name, description: '另一空间的独立方法', body: 'OTHER_SPACE_CANARY'.repeat(10),
        spaceId: otherSpace.id, originRunId: 'other', sessionKey: 'other', chatId: 'chat-b', chatType: 'group', proposerOpenId: 'bob' })
      t.skills.accept(other.id, 'Bob', 'bob')
      const denied = await t.request('/v1/skill/load', { name: p.name, proposal_id: other.id })
      expect(denied.status).not.toBe(200)
      expect(await denied.text()).not.toContain('OTHER_SPACE_CANARY')
    } }, { kind: 'text', text: '查到了。' }]
    await t.orchestrator.handleMessage(t.message())
    expect(t.skills.getRunSkillSet(captured!.runId!)!.served).toEqual([{ proposalId: p.id, contentDigest: p.contentDigest }])
    expect((await t.request('/v1/skill/load', { name: p.name, proposal_id: p.id }, captured!)).status).toBe(403)
  })

  it('self-disable cancels the actual Task, denies late HTTP work and sends only the fixed receipt', async () => {
    const t = await setup(), p = t.accept('需要停用的方法。')
    let captured: ReturnType<typeof t.cap> | undefined, operation!: Promise<void>
    t.fake.state.script = [{ kind: 'hook', run: () => operation = (async () => {
      captured = t.cap()
      t.orchestrator.noteCrossSpaceRead(captured.sessionKey, { chatId: 'source-other', name: '另一个来源', what: 'messages' })
      expect(t.orchestrator.canPersistDerivedState(captured.sessionKey)).toBe(false)
      const response = await t.request('/v1/skill/disable', { name: p.name, expected_revision: 1 })
      // The worker is retired by its own control action; the host delivers the fixed receipt.
      expect(response.status).toBe(403)
      expect((await t.request('/v1/skill/load', { name: p.name, proposal_id: p.id }, captured)).status).toBe(403)
      expect((await t.request('/v1/skill/propose', { name: 'late-proposal', description: '停用后不能提交', body: 'late'.repeat(80) }, captured)).status).toBe(403)
    })() }, { kind: 'text', text: 'MUST_NOT_SEND_MODEL_FINAL' }]
    await t.orchestrator.handleMessage(t.message())
    await operation
    expect(t.skills.getBinding(t.space.id, p.name)).toMatchObject({ enabled: false, revision: 2 })
    expect(t.registry.getTask(1)).toMatchObject({ status: 'cancelled', stopReason: 'skill_disabled' })
    expect(t.registry.db.prepare('SELECT state,stop_reason FROM run_attempts WHERE id=?').get(captured!.runId!)).toMatchObject({ state: 'cancelled', stop_reason: 'skill_disabled' })
    const sends = t.feishu.sent.filter(s => ['replyText', 'replyMarkdown', 'sendToUser', 'sendToChat'].includes(s.kind))
    expect(sends).toHaveLength(1)
    expect(JSON.stringify(sends)).toContain('已停用本空间')
    expect(JSON.stringify(sends)).not.toContain('MUST_NOT_SEND_MODEL_FINAL')
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'sent' }])
  })

  it('lets an actual host-created group consolidation read its pinned methods with the recorded sponsor and no additional memory reads or writes', async () => {
    const t = await setup(), p = t.accept('整理时先合并重复候选。')
    t.memory.add({ scope: `space:${t.space.id}`, kind: 'fact', title: '测试候选', body: '一个待确认事实', status: 'candidate' })
    let captured: ReturnType<typeof t.cap> | undefined
    t.fake.state.script = [{ kind: 'hook', run: async () => {
      captured = t.cap()
      expect(captured.requesterOpenId).toBe(t.space.createdBy)
      expect(captured.memoryWritePolicy).toBeUndefined()
      expect(captured.scopes).toEqual(['skill:read'])
      expect((await t.request('/v1/memory/search', { query: '' })).status).toBe(403)
      const list = await t.request('/v1/skill/list', {})
      expect(list.status).toBe(200)
      expect(JSON.stringify(await list.json())).toContain(p.name)
      const load = await t.request('/v1/skill/load', { name: p.name, proposal_id: p.id })
      expect(load.status).toBe(200)
      expect(JSON.stringify(await load.json())).toContain('整理时先合并重复候选')
      expect((await t.request('/v1/skill/propose', { name: 'unauthorized', description: '不能新增', body: 'x'.repeat(200) })).status).toBe(403)
      expect((await t.request('/v1/skill/disable', { name: p.name, expected_revision: 1 })).status).toBe(403)
    } }, { kind: 'text', text: '{"merges":[],"remove":[],"review":[]}' }]
    expect(await t.orchestrator.consolidateMemories({ minCandidates: 1 })).toBe(0)
    expect(captured).toBeDefined()
    expect(t.skills.getRunSkillSet(captured!.runId!)!.served.map(s => s.proposalId)).toEqual([p.id])
    expect(t.skills.getBinding(t.space.id, p.name)).toMatchObject({ enabled: true, revision: 1 })
    expect((await t.request('/v1/skill/load', { name: p.name, proposal_id: p.id }, captured!)).status).toBe(403)
  })

})
