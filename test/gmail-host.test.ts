import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Registry } from '../src/core/registry.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Todos } from '../src/core/todos.js'
import { PersonalCollectionStore } from '../src/core/personal-collection.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { EmailDrafts } from '../src/gmail/drafts.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import { createInternalApi } from '../src/internal/api.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { gmailFixture } from './helpers/gmail.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { FakeFeishu, asFeishuClient, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

it('prepares a sourced email via the signed host API, delivers an editable card, and sends after the model turn ends', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-gmail-host-')), registry = new Registry(':memory:')
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-secret', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: 'true', FRIDAY_DEFAULT_EXECUTION: 'managed', FRIDAY_REFLECT: 'off', FRIDAY_ACK_AFTER_MS: '0', FRIDAY_PROMPT_TIMEOUT_MS: '5000' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const log = createLogger('gmail-host-test', 'error'), sp = spaceDeps(registry.db), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_friday', openId: 'alice' })
  const f = await gmailFixture(false, registry.db), fake = new FakeFeishu(), feishu = asFeishuClient(fake)
  feishu.sendToUserOnce = (owner, payload) => fake.sendToUser(owner, payload)
  const userTokens = new UserTokenStore(registry.db, fake), tokens = new TokenIssuer('synthetic-test-key'), execution = managedHostRuntime(registry, home, log)
  const personalCollection = new PersonalCollectionStore(registry.db, todos)
  let host: Orchestrator
  const drafts = new EmailDrafts({ db: registry.db, connections: f.connections, mailbox: f.mailbox, authorize: (draft, guard) => host.authorizeEmailDraft(draft, guard) })
  host = new Orchestrator({ cfg, registry, ...sp, memory, todos, personalCollection, userTokens, gmail: f.connections, mailbox: f.mailbox, emailDrafts: drafts,
    feishu, runtime: execution.runtime, managed: execution.managed, tokens, botOpenId: 'ou_bot', log,
    ingressClassifier: { classify: async () => ({ kind: 'work_request' }) }, apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent' })
  const api = createInternalApi({ registry, ...sp, memory, todos, feishu, userTokens, tokens, log, maxHistoryPerCall: 20, appId: cfg.feishu.appId,
    gmail: f.connections, mailbox: f.mailbox, emailDrafts: drafts,
    resolveActorForSession: key => host.resolveActorForSession(key), allowedRoutesForSession: key => host.allowedRoutesForSession(key),
    canPersistDerivedState: key => host.canPersistDerivedState(key), onExternalSourceRead: (key, source) => host.noteExternalSource(key, source),
    captureEmailDraftSource: (key, run) => host.captureEmailDraftSource(key, run), consumeEmailDraft: (key, run, draft) => host.consumeEmailDraft(key, run, draft),
    showEmailDraft: (owner, id) => host.emailCards!.show(owner, id) })
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  let id = ''
  try {
    execution.peer.state.script = [{ kind: 'hook', run: async () => {
      const prompt = execution.peer.state.allPrompts.at(-1)!, server = (prompt.mcpServers as { env: { name: string; value: string }[] }[])[0]!
      const token = server.env.find(v => v.name === 'FRIDAY_CAP_TOKEN')!.value
      const response = await fetch(`${base}/v1/gmail/draft`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: ['bob@example.com'], subject: 'Plan review', body: 'I will review the plan.', thread_id: 'abc' }) })
      const result = await response.json() as { draft?: { id: string; source?: unknown } }
      expect(response.status, JSON.stringify(result)).toBe(200)
      id = result.draft!.id; expect(result.draft!.source).toBeUndefined()
    } }, { kind: 'text', text: '草稿已放在这里，可以继续修改。' }]
    const inbound = { eventId: 'mail-request', messageId: 'mail-request', chatId: 'oc_friday', chatType: 'p2p' as const, senderType: 'user' as const,
      senderOpenId: 'alice', msgType: 'text', text: '给 Bob 起草回复，我会看这份方案。', mentions: [], createTimeMs: Date.now() }
    fake.messages.set(inbound.messageId, historyMsg({ ...inbound, senderName: 'Alice' }))
    await host.handleMessage(inbound)
    expect(id).not.toBe('')
    expect(drafts.get('alice', id).source?.origin.ownerOpenId).toBe('alice')
    expect(fake.sent.some(item => JSON.stringify(item.payload).includes('发送邮件'))).toBe(true)
    expect(f.calls.some(call => call.path === '/messages/send')).toBe(false)
    // Enabling send on the same verified account must not strand the retained draft.
    await f.connect('alice', true)
    const check = await drafts.authorize('alice', id); check()
    const sent = await drafts.humanSend('alice', id, 1, () => {})
    expect(sent.state).toBe('sent')
    expect(f.calls.filter(call => call.path === '/messages/send')).toHaveLength(1)
  } finally {
    api.server.closeAllConnections(); await new Promise<void>(resolve => api.server.close(() => resolve()))
    host.beginShutdown(); await execution.runtime.stop(); await host.waitForShutdown(1000)
    registry.close(); rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
