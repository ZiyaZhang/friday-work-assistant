import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { RunApiCalls } from '../src/core/run-api-calls.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { inspectRecoveryEvidence } from '../src/core/recovery-evidence.js'
import { Registry } from '../src/core/registry.js'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { WikiDocs } from '../src/core/wiki.js'
import { Orchestrator, type AbilityActor } from '../src/core/orchestrator.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { FakeFeishu, asFeishuClient } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function recoveryFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-host-evidence-')), path = join(dir, 'db'), registry = new Registry(path)
  cleanup.push(async () => { registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const calls = new RunApiCalls(registry.db), runs = new RunAttempts(registry.db)
  registry.createSession({ sessionKey: 'session', chatId: 'chat', chatType: 'p2p', cwd: dir, requesterOpenId: 'alice' })
  const inbound = { eventId: 'event', messageId: 'message', chatId: 'chat', chatType: 'p2p' as const, senderOpenId: 'alice',
    senderType: 'user' as const, msgType: 'text', text: 'synthetic', mentions: [], createTimeMs: Date.now() }
  const task = registry.createTaskOnce({ sessionKey: 'session', messageId: inbound.messageId, requesterOpenId: 'alice', prompt: inbound.text, inbound }).task
  const run = runs.begin({ taskId: task.id, sessionKey: 'session', actorOpenId: 'alice', workKey: registry.taskWork.get(task.id)!.key,
    triggerKey: `task:${task.id}`, stage: 'task', now: Date.now() }, () => registry.startTask(task.id, Date.now(), 'session'))!
  runs.bindExecutionBoundary(run.id, 'managed_api_v1')
  const input = { taskId: task.id, runId: run.id, sessionKey: 'session', actorOpenId: 'alice' }
  const finish = () => { runs.finish(run.id, 'failed', Date.now(), 'authorization_required'); registry.updateTask(task.id, { status: 'failed', finishedAt: Date.now() }) }
  return { path, registry, calls, run, input, finish }
}
function hostFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friday-host-effects-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: dir,
    FRIDAY_ADMINS: 'bob,carol', FRIDAY_REFLECT: 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), sp = spaceDeps(registry.db, { admins: cfg.policy.admins })
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'chat', openId: 'alice' })
  const fake = new FakeFeishu(), agent = createFakeAgent(), log = createLogger('host-effects', 'error')
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: agent.app }, log, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const todos = new Todos(registry.db), wiki = new WikiDocs(registry.db)
  const host = new Orchestrator({ cfg, registry, memory, todos, wiki, ...sp, runtime, feishu: asFeishuClient(fake), tokens: new TokenIssuer('synthetic'),
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'bot', log })
  cleanup.push(async () => { await runtime.stop(); registry.close(); rmSync(dir, { recursive: true, force: true }) })
  const message: InboundMessage = { eventId: 'event', messageId: 'message', chatId: 'chat', chatType: 'group', senderOpenId: 'alice', senderType: 'user',
    msgType: 'text', text: '@Friday 检查合成事项', mentions: [{ key: '@Friday', name: 'Friday', openId: 'bot' }], createTimeMs: Date.now() }
  const actor = (): AbilityActor => {
    const task = registry.taskForMessage(message.messageId)!, current = host.resolveActorForSession(task.sessionKey)!
    return { runId: current.runId, sessionKey: task.sessionKey, requesterOpenId: 'alice', spaceId: space.id, chatId: 'chat', chatType: 'group' }
  }
  const calls = new RunApiCalls(registry.db)
  const rows = () => registry.db.prepare('SELECT route,state,scopes_json FROM run_api_calls ORDER BY started_at,rowid').all()
  return { host, registry, memory, todos, wiki, spaces: sp.spaces, space, cfg, fake, agent, message, actor, calls, rows }
}

describe('common host write evidence', () => {
  it('reserves scope before a provider call and distinguishes success from a lost acknowledgement', async () => {
    const t = recoveryFixture(), first = await t.calls.capture(t.run.id, 'HOST /synthetic', ['doc:write'], async () => {
      expect(t.calls.forRun(t.run.id)).toMatchObject([{ state: 'started', scopes: ['doc:write'] }])
      return 'PRIVATE_PROVIDER_RESULT'
    })
    expect(first).toBe('PRIVATE_PROVIDER_RESULT')
    await expect(t.calls.capture(t.run.id, 'HOST /synthetic', ['doc:write'], async () => { throw new Error('PRIVATE_PROVIDER_ERROR') })).rejects.toThrow('PRIVATE_PROVIDER_ERROR')
    expect(t.calls.forRun(t.run.id).map(call => call.state)).toEqual(['returned', 'failed'])
    expect(JSON.stringify(t.calls.forRun(t.run.id))).not.toMatch(/PRIVATE_PROVIDER/)
    t.finish()
    expect(inspectRecoveryEvidence(t.registry.db, t.input)).toMatchObject({ allowed: false, reasons: expect.arrayContaining(['effect_unresolved']) })
  })
  it('keeps a before-call reservation after reopening the database instead of treating it as no effect', async () => {
    const t = recoveryFixture()
    void t.calls.capture(t.run.id, 'HOST /documents/create', ['doc:write'], () => new Promise<never>(() => {}))
    t.finish()
    const reopened = new DatabaseSync(t.path)
    try {
      expect(new RunApiCalls(reopened).forRun(t.run.id)).toMatchObject([{ state: 'started', scopes: ['doc:write'] }])
      expect(inspectRecoveryEvidence(reopened, t.input)).toMatchObject({ allowed: false, reasons: ['effect_unresolved'] })
    } finally { reopened.close() }
  })
  it('preserves failed document writes even if the ability catches the provider error and returns fallback text', async () => {
    const t = hostFixture(), todo = t.todos.add({ scope: `space:${t.space.id}`, title: 'Synthetic completed item' })
    t.todos.done(todo.id, `space:${t.space.id}`)
    vi.spyOn(t.fake, 'createDocument').mockRejectedValue(new Error('synthetic lost acknowledgement'))
    let runId = ''
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const actor = t.actor(); runId = actor.runId!
      expect(await t.host.abilities.report(actor)).toContain('建文档失败')
    } }, { kind: 'text', text: '已保留实际状态。' }]
    await t.host.handleMessage(t.message)
    expect(t.calls.forRun(runId)).toMatchObject([{ route: 'HOST /documents/create', state: 'failed', scopes: ['doc:write'] }])
  })
  it('covers provider document methods at one adapter boundary, including a failed share after creation', async () => {
    const t = recoveryFixture(), fake = new FakeFeishu(), docs = t.calls.documents(t.run.id, asFeishuClient(fake))
    const created = await docs.createDocument({ title: 'PRIVATE_TITLE', markdown: 'PRIVATE_BODY' })
    vi.spyOn(fake, 'grantDocAccess').mockRejectedValue(new Error('PRIVATE_REMOTE_ERROR'))
    await expect(docs.grantDocAccess(created.documentId, { openId: 'alice' }, 'full_access')).rejects.toThrow('PRIVATE_REMOTE_ERROR')
    expect(t.calls.forRun(t.run.id).map(call => [call.route, call.state])).toEqual([
      ['HOST /documents/create', 'returned'], ['HOST /documents/grant', 'failed']])
    expect(JSON.stringify(t.calls.forRun(t.run.id))).not.toMatch(/PRIVATE_|documentId/)
    t.finish(); expect(inspectRecoveryEvidence(t.registry.db, t.input).allowed).toBe(false)
  })
  it('retains an explicitly requested wiki document but does not share it after its parent Run stops during creation', async () => {
    const t = hostFixture(), entered = deferred(), release = deferred()
    for (let n = 1; n <= 3; n++) t.todos.add({ scope: `space:${t.space.id}`, title: `Synthetic item ${n}` })
    const original = t.fake.createDocument.bind(t.fake)
    vi.spyOn(t.fake, 'createDocument').mockImplementation(async (...args) => {
      const doc = await original(...args); entered.resolve(); await release.promise; return doc
    })
    let runId = '', result = ''
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const actor = t.actor(); runId = actor.runId!
      t.agent.state.script = [{ kind: 'text', text: '[]' }]
      result = await t.host.abilities.wiki(actor)
    } }, { kind: 'text', text: 'MUST_NOT_PUBLISH' }]
    const pending = t.host.handleMessage({ ...t.message, text: '@Friday 将当前事项整理为 Wiki 文档' })
    await entered.promise
    try {
      const task = t.registry.taskForMessage(t.message.messageId)!
      t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId, taskId: task.id, assertCurrent: () => t.spaces.get(t.space.id)! }).afterCommit()
    } finally { release.resolve(); await pending }
    expect(t.fake.createdDocs).toHaveLength(1)
    expect(t.wiki.get(t.space.id)?.documentId).toBe(t.fake.createdDocs[0]!.documentId)
    expect(t.fake.grants).toEqual([])
    expect(result).toContain('原委托已停止')
    expect(t.calls.forRun(runId)).toMatchObject([{ route: 'HOST /documents/create', state: 'returned' }])
  })
})

describe('repository write copies belong to their actual Run', () => {
  it('reserves all recipients before any await and records actual returned sends', async () => {
    const t = hostFixture(); let runId = ''
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const actor = t.actor(); runId = actor.runId!
      t.host.abilities.ccRepositoryWrite(actor, { repo: 'synthetic/repo', action: '开了 PR' })
      expect(t.rows()).toEqual([expect.objectContaining({ state: 'started', scopes_json: '["dm:send"]' }), expect.objectContaining({ state: 'started', scopes_json: '["dm:send"]' })])
      await vi.waitFor(() => { expect(t.calls.forRun(runId).map(row => row.state)).toEqual(['returned', 'returned']) })
    } }, { kind: 'text', text: 'Synthetic result.' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.of('sendToUser').filter(item => ['bob', 'carol'].includes(item.target))).toHaveLength(2)
  })
  it('records a send failure even when another administrator copy succeeds', async () => {
    const t = hostFixture(), original = t.fake.sendToUser.bind(t.fake)
    vi.spyOn(t.fake, 'sendToUser').mockImplementation(async (openId, payload) => {
      const receipt = await original(openId, payload)
      if (openId === 'bob') throw new Error('synthetic receipt lost after sending')
      return receipt
    })
    let runId = ''
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const actor = t.actor(); runId = actor.runId!
      t.host.abilities.ccRepositoryWrite(actor, { repo: 'synthetic/repo', action: '更新 PR' })
      await vi.waitFor(() => { expect(t.calls.forRun(runId).map(row => row.state)).toEqual(['failed', 'returned']) })
    } }, { kind: 'text', text: 'PR本身已更新。' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.of('sendToUser').filter(item => ['bob', 'carol'].includes(item.target))).toHaveLength(2)
    expect(t.fake.answers().join('\n')).toContain('PR本身已更新')
  })
  it('does not send a late copy after stop during the shared name lookup', async () => {
    const t = hostFixture(), entered = deferred(), release = deferred()
    let runId = ''
    t.agent.state.script = [{ kind: 'hook', run: async () => {
      const actor = t.actor(); runId = actor.runId!
      vi.spyOn(t.fake, 'userName').mockImplementation(async () => { entered.resolve(); await release.promise; return 'Synthetic user' })
      t.host.abilities.ccRepositoryWrite(actor, { repo: 'synthetic/repo', action: '更新 PR' })
      await entered.promise
      const task = t.registry.taskForMessage(t.message.messageId)!
      const stopped = t.host.persistHumanRunStop({ actorOpenId: 'alice', spaceId: t.space.id, runId, taskId: task.id, assertCurrent: () => t.spaces.get(t.space.id)! })
      stopped.afterCommit()
      release.resolve()
      await vi.waitFor(() => { expect(t.calls.forRun(runId).map(row => row.state)).toEqual(['failed', 'failed']) })
    } }, { kind: 'text', text: 'MUST_NOT_SEND' }]
    await t.host.handleMessage(t.message)
    expect(t.fake.of('sendToUser').filter(item => ['bob', 'carol'].includes(item.target))).toHaveLength(0)
  })
})

it('requires every coordinator document mutation to use the common host adapter', () => {
  const path = new URL('../src/core/orchestrator.ts', import.meta.url), source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const violations: string[] = [], bindings: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'documents') bindings.push(node)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const call = node.expression, method = call.name.text
      if (/(Document|DocAccess)/.test(method) && !/^(read|get|list|download|search|can|check)/.test(method) && call.expression.getText(source) !== 'documents') {
        violations.push(call.getText(source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(violations).toEqual([])
  expect(bindings.length).toBeGreaterThan(0)
  expect(bindings.every(binding => binding.initializer && ts.isCallExpression(binding.initializer) &&
    binding.initializer.expression.getText(source) === 'this.runApiCalls.documents')).toBe(true)
})
