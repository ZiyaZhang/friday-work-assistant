import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { MessageCache } from '../src/core/message-cache.js'
import { MessageService } from '../src/core/messages.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Proactive } from '../src/core/proactive.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { RunAttempts } from '../src/core/run-attempts.js'
import { SourceContexts } from '../src/core/source-context.js'
import { Todos } from '../src/core/todos.js'
import { WikiDocs } from '../src/core/wiki.js'
import { UserTokenStore } from '../src/feishu/oauth.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { managedHostRuntime } from './helpers/managed-host.js'
import { asFeishuClient, FakeFeishu, historyMsg } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

describe('Public-mode task quota through host dispatch', () => {
  it('rejects the next new task before the actual ACP prompt and keeps control available', async () => {
    const t = fixture(); t.cfg.publicDailyTasks = 1
    const first = t.message('第一个合成任务。')
    await t.host.handleMessage(first)
    const second = t.message('独立的新合成任务。', { threadId:'omt_second' })
    await t.host.handleMessage(second)
    expect(t.peer.state.allPrompts).toHaveLength(1)
    expect(t.registry.taskForMessage(second.messageId)?.status).toBe('failed')
    expect(t.registry.taskForMessage(second.messageId)?.error).toContain('今天的新任务次数')
    expect(JSON.stringify(t.fake.sent)).toContain('今天的新任务次数已达到 1 次上限')
    expect(t.registry.db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(1)
    await t.host.handleMessage(t.message('/stop', { threadId:'omt_second' }))
    expect(t.peer.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(1)
  })

  it('zero blocks new non-admin work but not the billing administrator', async () => {
    const t = fixture(); t.cfg.publicDailyTasks = 0
    const member = t.message()
    await t.host.handleMessage(member)
    expect(t.peer.state.allPrompts).toHaveLength(0)
    expect(t.registry.taskForMessage(member.messageId)?.error).toContain('暂停新任务')
    expect(JSON.stringify(t.fake.sent)).toContain('当前已暂停新任务')
    await t.host.handleMessage(t.message('管理员自己的合成任务。', { senderOpenId:'ou_admin', threadId:'omt_admin' }))
    expect(t.workspacePeer.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(0)
  })

  it('keeps non-public behavior and explicit unlimited, while reflection charges once', async () => {
    const old = fixture({ publicMode:false }); old.cfg.publicDailyTasks = 0
    await old.host.handleMessage(old.message())
    expect(old.workspacePeer.state.allPrompts).toHaveLength(1)
    const t = fixture({ reflect:true }); t.cfg.publicDailyTasks = 'unlimited'; t.cfg.memory.reflectMinChars=1
    await t.host.handleMessage(t.message())
    expect(t.peer.state.allPrompts).toHaveLength(2)
    expect(t.registry.db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(1)
  })

  it('rejects malformed ceilings instead of silently disabling limits', () => {
    const base = { FEISHU_APP_ID:'synthetic', FEISHU_APP_SECRET:'synthetic' }
    expect(loadConfig(base).publicDailyTasks).toBe('unlimited')
    for (const value of ['-1','1.5','ten','NaN']) expect(() => loadConfig({...base, FRIDAY_PUBLIC_DAILY_TASKS:value})).toThrow('FRIDAY_PUBLIC_DAILY_TASKS')
    expect(loadConfig({...base, FRIDAY_PUBLIC_DAILY_TASKS:'0'}).publicDailyTasks).toBe(0)
    expect(loadConfig({...base, FRIDAY_PUBLIC_DAILY_TASKS:'unlimited'}).publicDailyTasks).toBe('unlimited')
  })

  it.each([0, 1])('counts standalone night work against its sponsor when ceiling is %s', async limit => {
    const t = fixture(); t.cfg.publicDailyTasks = limit
    if (limit) await t.host.handleMessage(t.message())
    t.peer.state.script = [{ kind: 'text', text: '{"merges":[],"remove":[],"review":[]}' }]
    t.memory.add({ scope: `space:${t.group.id}`, kind: 'fact', title: '独立夜间候选', body: '合成正文', status: 'candidate' })
    await t.host.consolidateMemories({ minCandidates: 1 })
    expect(t.peer.state.allPrompts).toHaveLength(limit)
    expect(t.registry.db.prepare('SELECT count(*) n FROM model_task_admissions').get()?.n).toBe(limit)
  })
})

function fixture(options: { publicMode?: boolean; managed?: boolean; mode?: 'workspace' | 'managed'; reflect?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'friday-public-mode-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'app_synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_PUBLIC_MODE: String(options.publicMode ?? true), FRIDAY_ADMINS: 'ou_admin', FRIDAY_DEFAULT_EXECUTION: options.mode ?? 'workspace',
    FRIDAY_REFLECT: options.reflect ? 'on' : 'off', FRIDAY_PROMPT_TIMEOUT_MS: '5000', FRIDAY_ACK_AFTER_MS: '0',
    FRIDAY_PROACTIVE_MIN_MESSAGES: '2' })
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:'), memory = new ChannelMemory(registry.db), todos = new Todos(registry.db)
  const attempts = new RunAttempts(registry.db), sources = new SourceContexts(registry), sp = spaceDeps(registry.db, { admins: cfg.policy.admins })
  const group = sp.spaces.ensure({ kind: 'group', chatId: 'oc_group', openId: 'ou_owner' })
  sp.spaces.touchMember(group.id, 'ou_admin')
  const dm = sp.spaces.ensure({ kind: 'p2p', chatId: 'oc_dm', openId: 'ou_owner' })
  const fake = new FakeFeishu(); fake.members.set('oc_group', new Set(['ou_owner', 'ou_admin'])); fake.chats = [{ chatId: 'oc_group', name: '合成测试群' }]
  const feishu = asFeishuClient(fake), cache = new MessageCache(registry.db), log = createLogger('public-mode', 'error')
  const execution = managedHostRuntime(registry, home, log), { runtime, managed, peer, workspacePeer } = execution
  peer.state.script = [{ kind: 'text', text: '受控执行的合成回复。' }]
  workspacePeer.state.script = [{ kind: 'text', text: '内部执行的合成回复。' }]
  const userTokens = new UserTokenStore(registry.db, { exchangeCode: async () => ({ accessToken: 'SYNTHETIC_USER_TOKEN', expiresIn: 7200,
    scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user' }), refresh: async () => { throw new Error('unexpected refresh') } })
  feishu.whoAmI = async () => ({ openId: 'ou_owner', tenantKey: 'tenant_synthetic' })
  fake.userChats.set('SYNTHETIC_USER_TOKEN', [{ chatId: 'oc_group', name: '合成测试群' }])
  const messages = new MessageService(feishu, cache, log), tokens = new TokenIssuer('synthetic-signing'), routines = new RoutineStore(registry.db)
  const proactive = new Proactive(registry.db, cfg.proactive)
  const host = new Orchestrator({ cfg, registry, ...sp, memory, todos, routines, proactive, wiki: new WikiDocs(registry.db), feishu, userTokens,
    runtime, ...(options.managed === false ? {} : { managed }), messages, tokens,
    ingressClassifier: { classify: async input => input.message.replyToRef ? { kind: 'amend', targetRef: input.message.replyToRef } : { kind: 'new_work' } },
    apiBaseUrl: 'http://127.0.0.1:1', mcpServerPath: '/nonexistent', botOpenId: 'ou_bot', log })
  closes.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  let serial = 0
  const message = (text = '请处理这个合成任务。', extra: Partial<InboundMessage> = {}): InboundMessage => {
    const messageId = `public-mode-${++serial}`
    return { eventId: messageId, messageId, chatId: 'oc_group', chatType: 'group', senderOpenId: 'ou_owner', senderType: 'user',
      tenantId: 'tenant_synthetic', msgType: 'text', text, mentions: [{ key: '@bot', openId: 'ou_bot', name: 'Friday' }],
      createTimeMs: Date.now(), threadId: 'omt_group', ...extra }
  }
  const cap = (prompt: typeof peer.state.allPrompts[number]) => {
    const servers = prompt.mcpServers as { env: { name: string; value: string }[] }[]
    return tokens.verify(servers[0]!.env.find(item => item.name === 'FRIDAY_CAP_TOKEN')!.value)!
  }
  return { cfg, registry, memory, attempts, sources, group, dm, sp, fake, userTokens, messages, cache, routines, proactive, host, execution, peer, workspacePeer, message, cap }
}

describe('Public mode through the actual host and two ACP runtimes', () => {
  it('admits a non-admin group owner only to managed and never resumes the old workspace conversation', async () => {
    const t = fixture({ publicMode: false }), first = t.message('合成旧任务。')
    await t.host.handleMessage(first)
    const original = t.workspacePeer.state.allPrompts[0]!
    expect(original).toBeDefined(); expect(t.execution.bindings.get(original.sessionId)).toBe('workspace')
    t.cfg.publicMode = true
    const next = t.message('补充同一任务。', { parentId: first.messageId })
    await t.host.handleMessage(next)
    expect(t.registry.taskForMessage(next.messageId)?.status).toBe('done')
    const current = t.peer.state.allPrompts[0]!
    expect(current).toBeDefined(); expect(current.sessionId).not.toBe(original.sessionId)
    expect(t.execution.bindings.get(current.sessionId)).toBe('managed')
    expect(t.workspacePeer.state.resumed).toEqual([]); expect(t.workspacePeer.state.allPrompts).toHaveLength(1)
    expect(t.peer.state.resumed).toEqual([])
    expect(t.sources.get(t.registry.getSessionByAcpId(current.sessionId)!.sessionKey)?.acpSessionId).toBe(current.sessionId)
  })

  it.each(['workspace', 'managed'] as const)('retains an administrator interactive preference for %s', async mode => {
    const t = fixture({ mode }), inbound = t.message(undefined, { senderOpenId: 'ou_admin' })
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    expect(t.workspacePeer.state.allPrompts).toHaveLength(mode === 'workspace' ? 1 : 0)
    expect(t.peer.state.allPrompts).toHaveLength(mode === 'managed' ? 1 : 0)
  })

  it('fails a non-admin task when managed is unavailable without dispatching workspace', async () => {
    const t = fixture({ managed: false }), inbound = t.message()
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)).toMatchObject({ status: 'failed', error: expect.stringContaining('受控执行尚未配置') })
    expect(t.workspacePeer.state.allPrompts).toEqual([]); expect(t.peer.state.allPrompts).toEqual([])
    expect(JSON.stringify(t.fake.sent)).toContain('受控执行尚未配置')
  })

  it('rejects an administrator grant removed while workspace creation awaits, before any prompt', async () => {
    const t = fixture(), inbound = t.message(undefined, { senderOpenId: 'ou_admin' })
    t.workspacePeer.state.onNewSession = () => { t.cfg.policy.admins.splice(0) }
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).not.toBe('done')
    expect(t.workspacePeer.state.allPrompts).toEqual([]); expect(t.peer.state.allPrompts).toEqual([])
    expect(t.workspacePeer.state.sessions.size).toBe(0)
  })

  it('cancels a live workspace turn and withholds its result when administrator authority is revoked', async () => {
    const t = fixture(), inbound = t.message(undefined, { senderOpenId: 'ou_admin' })
    t.workspacePeer.state.script = [{ kind: 'hook', run: () => { t.cfg.policy.admins.splice(0) } },
      { kind: 'text', text: 'MUST_NOT_DELIVER_REVOKED_RESULT' }, { kind: 'sleep', ms: 1 }]
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).not.toBe('done')
    expect(t.workspacePeer.state.cancelled.length).toBeGreaterThan(0)
    expect(JSON.stringify(t.fake.sent)).not.toContain('MUST_NOT_DELIVER_REVOKED_RESULT')
  })

  it('drops an administrator workspace history after the administrator role is removed', async () => {
    const t = fixture(), first = t.message(undefined, { senderOpenId: 'ou_admin' })
    await t.host.handleMessage(first)
    const original = t.workspacePeer.state.allPrompts[0]!
    t.cfg.policy.admins.splice(0)
    const next = t.message('撤去管理权限后继续。', { senderOpenId: 'ou_admin', parentId: first.messageId })
    await t.host.handleMessage(next)
    expect(t.workspacePeer.state.allPrompts).toHaveLength(1); expect(t.workspacePeer.state.resumed).toEqual([])
    expect(t.peer.state.allPrompts).toHaveLength(1)
    expect(t.peer.state.allPrompts[0]!.sessionId).not.toBe(original.sessionId)
    expect(t.registry.taskForMessage(next.messageId)?.status).toBe('done')
  })

  it('uses the same managed admission for the private-memory reader even with workspace configured by default', async () => {
    const t = fixture()
    await t.userTokens.complete({ openId: 'ou_owner', code: 'synthetic', redirectUri: 'https://callback.invalid' })
    t.memory.add({ scope: `space:${t.dm.id}`, kind: 'fact', title: 'ManagedSourceFact', body: 'MANAGED_SOURCE_BODY',
      provenance: { state: 'verified', originRunId: 'synthetic-origin', sources: [{ ref: 'feishu-message:oc_group:om_original',
        appId: 'app_synthetic', tenantId: 'tenant_synthetic', spaceId: t.group.id, chatId: 'oc_group', messageId: 'om_original',
        readIdentity: { kind: 'user', openId: 'ou_owner' }, readAt: Date.now(), coverage: 'complete' }] } })
    const inbound = t.message('ManagedSourceFact', { chatId: 'oc_dm', chatType: 'p2p', threadId: undefined, mentions: [] })
    await t.host.handleMessage(inbound)
    expect(t.registry.taskForMessage(inbound.messageId)?.status).toBe('done')
    expect(t.peer.state.allPrompts[0]!.text).toContain('MANAGED_SOURCE_BODY')
    expect(t.workspacePeer.state.allPrompts).toEqual([])
  })

  it('keeps an administrator-sponsored routine in managed with no workspace runtime use', async () => {
    const t = fixture(); t.peer.state.script = [{ kind: 'text', text: 'NOTHING' }]
    const routine = t.routines.add({ kind: 'schedule', ownerOpenId: 'ou_admin', chatId: 'oc_group', chatType: 'group',
      name: '合成后台任务', prompt: '看看', schedule: { type: 'daily', at: '09:00' } })
    await t.host.runRoutine(routine, { manualMessageId: 'synthetic-manual-trigger' })
    expect(t.peer.state.allPrompts).toHaveLength(1); expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.execution.bindings.get(t.peer.state.allPrompts[0]!.sessionId)).toBe('managed')
  })

  it('runs proactive checks in managed using only the explicit read-only MCP capability', async () => {
    const t = fixture(); t.proactive.enable('oc_group', 'ou_owner')
    t.peer.state.script = [{ kind: 'permission', text: 'native shell', rawInput: { command: 'echo synthetic' } }, { kind: 'text', text: 'NOTHING' }]
    const now = Date.now()
    for (let i = 0; i < 2; i++) t.messages.remember('oc_group', historyMsg({ messageId: `om_proactive_${i}`, chatId: 'oc_group',
      senderOpenId: 'ou_owner', senderName: '合成人员', text: `合成讨论 ${i}`, createTimeMs: now + 1000 + i }))
    await t.host.runProactiveCheck('oc_group')
    expect(t.peer.state.allPrompts).toHaveLength(1); expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.cap(t.peer.state.allPrompts[0]!).scopes.every(scope => scope.endsWith(':read') || scope === 'chats:list')).toBe(true)
    expect(t.peer.state.permissionDecisions).toEqual(['cancelled'])
    const session = t.registry.getSessionByAcpId(t.peer.state.allPrompts[0]!.sessionId)!
    expect(t.sources.get(session.sessionKey)).toMatchObject({ acpSessionId: session.acpSessionId, chatId: 'oc_group' })
  })

  it('runs night consolidation through managed and preserves the narrow host commit protocol', async () => {
    const t = fixture(); t.peer.state.script = [{ kind: 'text', text: '{"merges":[],"remove":[],"review":[]}' }]
    t.memory.add({ scope: `space:${t.group.id}`, kind: 'fact', title: '合成候选', body: '合成正文', status: 'candidate' })
    await t.host.consolidateMemories({ minCandidates: 1 })
    expect(t.peer.state.allPrompts).toHaveLength(1); expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.cap(t.peer.state.allPrompts[0]!).scopes).toEqual(['skill:read'])
    expect(t.execution.bindings.get(t.peer.state.allPrompts[0]!.sessionId)).toBe('managed')
  })

  it('reflects a managed conversation only through managed, with a distinct background Run', async () => {
    const t = fixture({ reflect: true }); t.cfg.memory.reflectMinChars = 1
    const inbound = t.message()
    await t.host.handleMessage(inbound)
    expect(t.peer.state.allPrompts).toHaveLength(2); expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.registry.db.prepare('SELECT stage,state FROM run_attempts ORDER BY rowid').all()).toEqual([
      { stage: 'task', state: 'completed' }, { stage: 'reflect', state: 'completed' },
    ])
    expect(t.cap(t.peer.state.allPrompts[0]!).runId).not.toBe(t.cap(t.peer.state.allPrompts[1]!).runId)
  })

  it('does not continue an administrator workspace transcript for unattended reflection', async () => {
    const t = fixture({ reflect: true }); t.cfg.memory.reflectMinChars = 1
    await t.host.handleMessage(t.message(undefined, { senderOpenId: 'ou_admin' }))
    expect(t.workspacePeer.state.allPrompts).toHaveLength(1); expect(t.peer.state.allPrompts).toEqual([])
    expect(t.registry.db.prepare('SELECT stage,state FROM run_attempts').all()).toEqual([{ stage: 'task', state: 'completed' }])
  })

  it('rebuilds an administrator workspace conversation in managed when an automatic followup runs', async () => {
    const t = fixture(), inbound = t.message(undefined, { senderOpenId: 'ou_admin' })
    await t.host.handleMessage(inbound)
    const session = t.registry.getSessionByAcpId(t.workspacePeer.state.allPrompts[0]!.sessionId)!
    const routine = t.routines.add({ kind: 'followup', ownerOpenId: 'ou_admin', chatId: 'oc_group', chatType: 'group',
      name: '合成跟进', prompt: '确认合成事项进展。', schedule: { type: 'once', atMs: Date.now() + 60_000 }, sessionKey: session.sessionKey })
    await expect(t.host.runRoutine(routine, { manualMessageId: 'synthetic-followup-trigger' })).resolves.toBe('ok')
    expect(t.workspacePeer.state.allPrompts).toHaveLength(1); expect(t.workspacePeer.state.resumed).toEqual([])
    expect(t.peer.state.allPrompts).toHaveLength(1)
    expect(t.execution.bindings.get(t.peer.state.allPrompts[0]!.sessionId)).toBe('managed')
  })

  it('closes the unsafe legacy bulk Wiki export in public mode instead of publishing without audience proofs', async () => {
    const t = fixture()
    const text = await t.host.abilities.wiki({ sessionKey: 'synthetic-wiki', chatId: 'oc_group', chatType: 'group', requesterOpenId: 'ou_owner' })
    expect(text).toContain('来源与受众核验'); expect(text).toContain('未执行')
    expect(t.peer.state.allPrompts).toEqual([]); expect(t.workspacePeer.state.allPrompts).toEqual([])
    expect(t.fake.createdDocs).toHaveLength(0)
  })
})
