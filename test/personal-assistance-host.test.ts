import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { Todos } from '../src/core/todos.js'
import { ChannelMemory } from '../src/core/memory.js'
import { PersonalCollectionStore, PERSONAL_COLLECTION_SCOPES } from '../src/core/personal-collection.js'
import { ChatReadScope } from '../src/core/chat-read-scope.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { GitHubUserConnections } from '../src/github/user-connection.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const values = (object: unknown): Record<string, any>[] => !object || typeof object !== 'object' ? []
  : [object as Record<string, any>, ...Object.values(object).flatMap(values)]

async function fixture(kind: 'feishu' | 'github' = 'feishu') {
  const home = mkdtempSync(join(tmpdir(), 'friday-personal-assistance-')), registry = new Registry(':memory:')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const log = createLogger('personal-assistance-test', 'error'), spaces = spaceDeps(registry.db)
  spaces.spaces.ensure({ kind: 'p2p', chatId: 'oc_friday', openId: 'ou_owner' })
  const fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  feishu.sendToUserOnce = (owner, payload) => fake.sendToUser(owner, payload)
  fake.nextToken.scope = [...PERSONAL_COLLECTION_SCOPES, 'im:chat:readonly'].join(' ')
  fake.identities.set('uat-1', { openId: 'ou_owner', tenantKey: 'tenant-test' })
  const userTokens = new UserTokenStore(registry.db, fake)
  await userTokens.complete({ openId: 'ou_owner', code: 'synthetic-code', redirectUri: 'https://example.test/oauth' })
  const todos = new Todos(registry.db), personalCollection = new PersonalCollectionStore(registry.db, todos), readScope = new ChatReadScope(registry.db)
  const execution = managedHostRuntime(registry, home, log), tokens = new TokenIssuer('synthetic-test-key')
  const personalGithub = kind === 'github' ? new GitHubUserConnections({ db: registry.db, key: Buffer.alloc(32, 1), log,
    config: { clientId: 'synthetic', clientSecret: 'synthetic', relayToken: 'synthetic', redirectUri: 'https://test.invalid/github/callback' },
    http: async path => {
      if (path.includes('access_token')) return { status: 200, data: { access_token: 'ghu_owner', token_type: 'bearer' } }
      if (path === '/user') return { status: 200, data: { id: 1, login: 'owner' } }
      if (path.startsWith('/user/installations')) return { status: 200, data: { total_count: 1 } }
      if (path.startsWith('/search/issues')) {
        const items = path.includes('review-requested') ? [{ html_url: 'https://github.com/team/private/pull/41', title: '发布文案', state: 'open', updated_at: '2026-09-30T01:00:00Z' }] : []
        return { status: 200, data: { total_count: items.length, items } }
      }
      if (path === '/repos/team/private/pulls/41') return { status: 200, data: { state: 'open', updated_at: '2026-09-30T01:00:00Z',
        merged: false, draft: false, head: { sha: 'a'.repeat(40) }, requested_reviewers: [{ login: 'owner' }] } }
      throw new Error('Unexpected GitHub request')
    } }) : undefined
  if (personalGithub) await personalGithub.complete(new URL(personalGithub.begin('ou_owner').url).searchParams.get('state')!, 'ou_owner', 'synthetic')
  const host = new Orchestrator({ cfg, registry, ...spaces, memory: new ChannelMemory(registry.db), todos, personalCollection, readScope,
    userTokens, personalGithub, feishu, runtime: execution.runtime, managed: execution.managed, tokens, botOpenId: 'ou_bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  cleanups.push(async () => { host.beginShutdown(); await execution.runtime.stop(); await host.waitForShutdown(1000); registry.close(); rmSync(home, { recursive: true, force: true }) })
  personalCollection.configure('ou_owner', true)
  if (kind === 'github') {
    await host.personalGithubDiscovery!.refresh('ou_owner')
    await host.personalWorkSync!.tick()
  } else {
  const message = historyMsg({ messageId: 'om_personal_request', chatId: 'oc_human_private', text: '发布文案该选 A 还是 B？请给一个意见。',
    senderOpenId: 'ou_colleague', createTimeMs: Date.now() - 1000 })
  fake.messages.set(message.messageId, message)
  personalCollection.commit({ profile: personalCollection.profile('ou_owner')!, cursor: personalCollection.next('ou_owner')!,
    audience: { openId: 'ou_owner', chatId: 'oc_friday', chatType: 'p2p', scope: 'space:sp_dm_ou_owner' }, candidates: [], assertCurrent() {},
    messages: [{ text: message.text, mentions: [], metadata: { ...message, chatId: 'oc_human_private', chatType: 'p2p', senderOpenId: 'ou_colleague', link: { status: 'unavailable' } } }],
    decisions: [{ messageId: message.messageId, quote: message.text, title: '回复发布文案选择', kind: 'reply', relationship: 'requested', operation: 'record', dueMs: null, existingId: null }] })
  }
  const messageId = await host.personalOnboarding!.show('ou_owner', 'tasks')
  const action = values(fake.sent.at(-1)!.payload).find(item => item.op === 'assist')!
  expect(action).toBeDefined()
  return { registry, host, fake, feishu, tokens, readScope, execution, messageId, action, todos, personalGithub }
}

describe('personal assistance through the actual host and managed execution', () => {
  it('prepares a native GitHub review under the owner grant without inventing a Feishu message', async () => {
    const t = await fixture('github')
    t.execution.peer.state.script = [{ kind: 'text', text: '评审要点：先核对发布文案的目标用户，再看 PR #41 的改动。' }]
    await t.host.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_friday', messageId: t.messageId, value: t.action, raw: {} })
    const taskId = t.host.personalAssistance!.get(String(t.action.offer))!.taskId!
    await expect.poll(() => t.registry.getTask(taskId)?.status, { timeout: 6000 }).toBe('done')
    const context = new SourceContexts(t.registry).get(t.registry.getTask(taskId)!.sessionKey)!
    expect(context.personalRepositories).toContainEqual({ owner: 'ou_owner', repo: 'team/private', revision: 1 })
    expect(context.chats).toEqual([])
    expect(t.fake.answers().join('\n')).toContain('评审要点：')
    expect(t.todos.get(1)?.status).toBe('open')
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
  })

  it('suppresses a prepared result when the owner disconnects during execution', async () => {
    const t = await fixture('github')
    t.execution.peer.state.script = [{ kind: 'hook', run: () => t.personalGithub!.disconnect('ou_owner', 1) }, { kind: 'text', text: 'OLD_ACCOUNT_RESULT_MUST_NOT_SEND' }]
    await t.host.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_friday', messageId: t.messageId, value: t.action, raw: {} })
    const taskId = t.host.personalAssistance!.get(String(t.action.offer))!.taskId!
    await expect.poll(() => t.registry.getTask(taskId)?.status, { timeout: 6000 }).toBe('cancelled')
    expect(t.fake.answers().join('\n')).not.toContain('OLD_ACCOUNT_RESULT_MUST_NOT_SEND')
  })

  it('can record the owner’s private todo after a verified DM preparation, without granting personal-memory writes', async () => {
    const t = await fixture()
    t.execution.peer.state.script = [{ kind: 'text', text: '先确认文案面向的用户，再选 A 或 B。' }]
    await t.host.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_friday', messageId: t.messageId, value: t.action, raw: {} })
    const task = t.host.personalAssistance!.get(String(t.action.offer))!.taskId!
    await expect.poll(() => t.registry.getTask(task)?.status, { timeout: 6000 }).toBe('done')
    const sources = new SourceContexts(t.registry), sessionKey = t.registry.getTask(task)!.sessionKey
    const before = sources.get(sessionKey)!
    // Human DM reads have ordinary receipts but are ineligible for group-memory capture.
    sources.recordMessages({ sessionKey, acpSessionId: before.acpSessionId, spaceId: before.spaceId, chatId: before.chatId }, [], false)
    let observed: unknown
    t.execution.peer.state.script = [{ kind: 'hook', run: () => {
      const context = sources.get(sessionKey)!
      const allowed = t.host.canPersistDerivedState(sessionKey), memory = t.host.canPersistDerivedState(sessionKey, 'memory')
      // Removing the receipt cannot certify an old opaque input.
      t.registry.setKv(`delivery-sources:${sessionKey}`, JSON.stringify({ ...context,
        conversationReads: { complete: false, items: context.conversationReads!.items } }))
      const incomplete = t.host.canPersistDerivedState(sessionKey)
      t.registry.setKv(`delivery-sources:${sessionKey}`, JSON.stringify(context))
      observed = { memoryComplete: context.personalMemoryComplete, conversationComplete: context.conversationReads?.complete, allowed, memory, incomplete }
    } }, { kind: 'text', text: '这条待办可以保留在你的个人清单。' }]
    // An independent preparation no longer replaces the main personal
    // conversation. Explicitly reply to its output to continue that work.
    const message = { eventId: 'om_followup', messageId: 'om_followup', chatId: 'oc_friday', chatType: 'p2p' as const,
      parentId: t.registry.getTask(task)!.cardMessageId!,
      senderType: 'user' as const, senderOpenId: 'ou_owner', msgType: 'text', text: '记个待办：明天检查文案', mentions: [], createTimeMs: Date.now() }
    t.fake.messages.set(message.messageId, historyMsg({ ...message, senderName: 'Owner' }))
    await t.host.handleMessage(message)
    expect(t.registry.taskForMessage(message.messageId)?.sessionKey).toBe(sessionKey)
    expect(observed).toEqual({ memoryComplete: false, conversationComplete: true, allowed: true, memory: false, incomplete: false })
  })

  it('revalidates a human DM, admits a read-only worker, delivers a real answer only to the owner and keeps the original item open', async () => {
    const t = await fixture()
    t.execution.peer.state.script = [{ kind: 'hook', run: () => {
      expect(t.fake.sent.some(item => item.kind === 'patchCard' && item.target === t.messageId &&
        JSON.stringify(item.payload).includes('正在整理，结果会发在这里。'))).toBe(true)
      const servers = t.execution.peer.state.allPrompts.at(-1)!.mcpServers as { env: { name: string; value: string }[] }[]
      const cap = t.tokens.verify(servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value)!
      expect(cap.requesterOpenId).toBe('ou_owner')
      expect(cap.scopes).toContain('github:read')
      expect(cap.scopes).toContain('chat:read-others')
      expect(cap.scopes.some(scope => /write|send|execute/.test(scope))).toBe(false)
    } }, { kind: 'text', text: '回复草稿：我先核对目标用户和发布场景，再确认用 A 还是 B。' }]
    const result = await t.host.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_friday', messageId: t.messageId, value: t.action, raw: {} })
    expect(result?.toast).toBeUndefined()
    const taskId = t.host.personalAssistance!.get(String(t.action.offer))!.taskId!
    await expect.poll(() => t.registry.getTask(taskId)?.status, { timeout: 6000 }).toBe('done')
    expect(t.execution.workspacePeer.state.allPrompts).toHaveLength(0)
    expect(t.fake.answers().join('\n')).toContain('回复草稿：')
    expect(t.fake.sent.every(item => item.target === 'ou_owner' || item.target === 'oc_friday' || item.kind === 'patchCard' && item.target === t.messageId)).toBe(true)
    const source = new SourceContexts(t.registry).get(t.registry.getTask(taskId)!.sessionKey)
    expect(source?.conversationReads?.items).toContainEqual(expect.objectContaining({ chatId: 'oc_human_private', readIdentity: { kind: 'user', openId: 'ou_owner', tenantId: 'tenant-test' } }))
    expect(t.todos.get(1)?.status).toBe('open')
  })

  it('does not run or deliver old content when the source message was edited after the suggestion', async () => {
    const t = await fixture()
    t.fake.messages.set('om_personal_request', { ...t.fake.messages.get('om_personal_request')!, text: '取消这个请求。' })
    t.execution.peer.state.script = [{ kind: 'text', text: 'MUST_NOT_BE_DELIVERED' }]
    await t.host.handleCardAction({ operatorOpenId: 'ou_owner', chatId: 'oc_friday', messageId: t.messageId, value: t.action, raw: {} })
    const taskId = t.host.personalAssistance!.get(String(t.action.offer))!.taskId!
    await expect.poll(() => t.registry.getTask(taskId)?.status, { timeout: 6000 }).toBe('failed')
    expect(t.execution.peer.state.allPrompts).toHaveLength(0)
    expect(t.fake.answers().join('\n')).not.toContain('MUST_NOT_BE_DELIVERED')
  })
})
