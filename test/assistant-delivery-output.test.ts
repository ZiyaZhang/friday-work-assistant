import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator, applyUpdate, type AbilityActor } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { repositoryResultLink, withRepositoryResultLinks } from '../src/core/repository-result-links.js'
import type { TaskCardState } from '../src/feishu/cards.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { postContent } from '../src/feishu/post.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const url = 'https://github.com/org/demo/pull/5066'
const final = '已修复单复数，另一个问题的答案也在这里。'
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'friday-output-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const fake = new FakeFeishu(), agent = createFakeAgent(), log = createLogger('output', 'error')
  fake.members.set('chat', new Set(['alice', 'ou_owner']))
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const host = new Orchestrator({ cfg, registry, memory, ...sp, runtime, feishu: asFeishuClient(fake), tokens: new TokenIssuer('synthetic'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const message: InboundMessage = { eventId: 'event', messageId: 'message', chatId: 'chat', chatType: 'group', senderOpenId: 'alice', senderType: 'user',
    msgType: 'text', text: '@Friday 修复并交付 PR', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  const actor = (): AbilityActor => {
    const task = registry.taskForMessage(message.messageId)!, current = host.resolveActorForSession(task.sessionKey)!
    return { runId: current.runId, sessionKey: task.sessionKey, requesterOpenId: 'alice', spaceId: space.id, chatId: 'chat', chatType: 'group' }
  }
  return { host, registry, fake, agent, message, actor, space, spaces: sp.spaces }
}

describe('ACP answer message boundaries', () => {
  const state = (): TaskCardState => ({ title: 't', phase: 'working', tools: [], body: '' })
  it('joins chunks of one message and replaces earlier assistant messages, without rewriting links or mentions', () => {
    const s = state()
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'plan', content: { type: 'text', text: "Now I'll add regression tests." } })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: `<at open_id="ou_owner">同事</at> [PR](${url})` } })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: ' 已提交。' } })
    expect(s.body).toBe(`<at open_id="ou_owner">同事</at> [PR](${url}) 已提交。`)
  })
  it.each([true, false])('retires tool preambles, including legacy peers without messageId (%s)', identified => {
    const s = state(), id = identified ? { messageId: 'plan' } : {}
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', ...id, content: { type: 'text', text: '先读取代码。' } })
    applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read' })
    expect(s.body).toBe('')
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', ...(identified ? { messageId: 'answer' } : {}), content: { type: 'text', text: final } })
    expect(s.body).toBe(final)
  })
  it('does not resurrect an old message from a late chunk after a tool boundary', () => {
    const s = state()
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'plan', content: { type: 'text', text: '开始。' } })
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 'unannounced', status: 'completed' })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'plan', content: { type: 'text', text: '旧消息迟到片段' } })
    expect(s.body).toBe('')
  })
  it('does not discard the final message on a late status update for an already known tool', () => {
    const s = state()
    applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read' })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: final } })
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' })
    applyUpdate(s, { sessionUpdate: 'agent_thought_chunk', messageId: 'thought', content: { type: 'text', text: 'not an answer' } })
    expect(s.body).toBe(final)
  })
})

describe('host-confirmed repository delivery links', () => {
  it('delivers both real current-Run links when the model omits them, retaining mixed answers and member mentions', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'text', text: "Now I'll add regression tests." }, { kind: 'tool', text: 'publish' },
      { kind: 'hook', run: () => {
        for (const link of [url, 'https://github.com/org/demo/pull/5067', url]) {
          t.host.abilities.ccRepositoryWrite(t.actor(), { repo: 'org/demo', action: '开了 PR', url: link })
        }
      } }, { kind: 'text', text: `${final} 请 <at open_id="ou_owner">同事</at> 看一下。` }]
    await t.host.handleMessage(t.message)
    const answer = t.fake.answers().join('\n')
    expect(answer.startsWith('已确认')).toBe(true)
    expect(answer.split(url)).toHaveLength(2)
    expect(answer).toContain('https://github.com/org/demo/pull/5067')
    expect(answer).toContain(final)
    expect(answer).toContain('<at open_id="ou_owner">同事</at>')
    expect(answer).not.toContain("Now I'll")
    expect(JSON.stringify(postContent(answer))).toContain(url)
  })
  it('does not turn a tool preamble alone into a successful final answer', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'text', text: '我会开始处理。' }, { kind: 'tool', text: 'read' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers().join('\n')).not.toContain('我会开始处理')
    const run = t.registry.db.prepare('SELECT result_json FROM run_attempts WHERE stage=?').get('task')!
    expect(JSON.parse(String(run.result_json)).outcome).not.toBe('handled')
  })
  it('can deliver an actual confirmed result when no assistant final follows the tool', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'text', text: '我要发布。' }, { kind: 'tool', text: 'publish' },
      { kind: 'hook', run: () => t.host.abilities.ccRepositoryWrite(t.actor(), { repo: 'org/demo', action: '开了 PR', url }) }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers()).toEqual([`已确认 [org/demo PR #5066](${url})。`])
  })
  it('keeps an already linked final answer byte-for-byte and never invents a URL from a number', () => {
    const linked = `[PR #5066](${url})：${final}`
    expect(withRepositoryResultLinks(linked, [repositoryResultLink({ repo: 'org/demo', url })!])).toBe(linked)
    expect(repositoryResultLink({ repo: 'org/demo', url: '5066' })).toBeUndefined()
    expect(repositoryResultLink({ repo: 'org/demo', url: 'https://github.com.evil.test/org/demo/pull/5066' })).toBeUndefined()
    expect(repositoryResultLink({ repo: 'org/demo', url: 'https://user:secret@github.com/org/demo/pull/5066' })).toBeUndefined()
  })
  it('does not carry a previous Run or Work publication into another request', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: () => t.host.abilities.ccRepositoryWrite(t.actor(), { repo: 'org/demo', action: '开了 PR', url }) },
      { kind: 'text', text: final }]
    await t.host.handleMessage(t.message)
    const before = t.fake.answers().length
    t.agent.state.script = [{ kind: 'text', text: '另一个独立问题的答案。' }]
    await t.host.handleMessage({ ...t.message, eventId: 'other-event', messageId: 'other-message', text: '@Friday 另一个独立问题' })
    expect(t.agent.state.allPrompts).toHaveLength(2)
    expect(t.fake.answers().slice(before)).toEqual(['另一个独立问题的答案。'])
    const original = t.registry.taskForMessage('message')!, other = t.registry.taskForMessage('other-message')!
    expect(t.registry.taskWork.get(other.id)?.key).not.toBe(t.registry.taskWork.get(original.id)?.key)
  })
  it.each(['stale-run', 'wrong-actor', 'foreign-repo-url', 'missing-url'] as const)('does not invent a result from %s', async kind => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: () => {
      const actor = t.actor()
      t.host.abilities.ccRepositoryWrite({ ...actor, ...(kind === 'stale-run' ? { runId: 'old-run' } : {}),
        ...(kind === 'wrong-actor' ? { requesterOpenId: 'bob' } : {}) },
      { repo: 'org/demo', action: '开了 PR', url: kind === 'missing-url' ? undefined : kind === 'foreign-repo-url' ? 'https://github.com/other/repo/pull/5066' : url })
    } }, { kind: 'text', text: final }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers()).toEqual([final])
  })
  it('never bypasses the final source gate with a confirmed GitHub link', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: () => {
      const actor = t.actor()
      t.host.abilities.ccRepositoryWrite(actor, { repo: 'org/demo', action: '开了 PR', url })
      t.host.noteCrossSpaceRead(actor.sessionKey, { chatId: 'private-other-group', name: '合成群', what: 'history' })
    } }, { kind: 'text', text: final }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers().join('\n')).not.toContain(url)
    expect(t.fake.answers().join('\n')).not.toContain(final)
  })
  it('does not send even a real publication after its user stops the Run', async () => {
    const t = fixture()
    t.agent.state.script = [{ kind: 'hook', run: () => {
      const actor = t.actor(), task = t.registry.taskForMessage('message')!
      t.host.abilities.ccRepositoryWrite(actor, { repo: 'org/demo', action: '开了 PR', url })
      t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId: actor.runId!, taskId: task.id,
        assertCurrent: () => t.spaces.get(t.space.id)! }).afterCommit()
    } }, { kind: 'text', text: final }]
    await t.host.handleMessage(t.message)
    expect(t.fake.answers().join('\n')).not.toContain(url)
    expect(t.fake.answers().join('\n')).not.toContain(final)
  })
})
