import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '../src/acp/runtime.js'
import { loadConfig } from '../src/config.js'
import { ChannelMemory } from '../src/core/memory.js'
import { Orchestrator } from '../src/core/orchestrator.js'
import { Registry } from '../src/core/registry.js'
import { RoutineStore } from '../src/core/routines.js'
import { WikiDocs } from '../src/core/wiki.js'
import type { InboundMessage } from '../src/feishu/mention.js'
import { TokenIssuer } from '../src/internal/tokens.js'
import { createLogger } from '../src/log.js'
import { createFakeAgent } from './helpers/fake-agent.js'
import { asFeishuClient, FakeFeishu } from './helpers/fake-feishu.js'
import { spaceDeps } from './helpers/space.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function message(text = '@Friday 回答'): InboundMessage {
  return { eventId: 'synthetic-event', messageId: 'om_synthetic', chatId: 'oc_synthetic', chatType: 'group',
    msgType: 'text', text, senderOpenId: 'ou_owner', senderType: 'user', createTimeMs: Date.now(),
    mentions: [{ key: '@Friday', openId: 'ou_bot', name: 'Friday' }] }
}

function setup(reflect = false) {
  const home = mkdtempSync(join(tmpdir(), 'friday-lifecycle-races-'))
  const cfg = loadConfig({ FEISHU_APP_ID: 'synthetic', FEISHU_APP_SECRET: 'synthetic', FRIDAY_HOME: home,
    FRIDAY_REFLECT: reflect ? 'on' : 'off' } as NodeJS.ProcessEnv)
  mkdirSync(cfg.workspace.root, { recursive: true })
  const registry = new Registry(':memory:')
  const sp = spaceDeps(registry.db)
  const space = sp.spaces.ensure({ kind: 'group', chatId: 'oc_synthetic', openId: 'ou_owner' })
  const memory = new ChannelMemory(registry.db)
  const wiki = new WikiDocs(registry.db)
  const feishu = new FakeFeishu()
  feishu.threadIdForReply = 'omt_synthetic'
  const log = createLogger('lifecycle-races', 'error')
  const { app, state } = createFakeAgent({ script: [{ kind: 'tool', text: '合成只读步骤' }, { kind: 'text', text: '合成结果' }] })
  let orchestrator!: Orchestrator
  const runtime = new AcpRuntime({ transport: { kind: 'inproc', agent: app },
    onPermission: (req, signal) => orchestrator.handlePermission(req, signal), log })
  orchestrator = new Orchestrator({ cfg, registry, ...sp, memory, wiki, routines: new RoutineStore(registry.db),
    feishu: asFeishuClient(feishu), runtime, tokens: new TokenIssuer('synthetic'), apiBaseUrl: 'http://127.0.0.1:1',
    mcpServerPath: '/nonexistent/synthetic-mcp.js', botOpenId: 'ou_bot', log })
  cleanups.push(async () => { await runtime.stop(); registry.close(); rmSync(home, { recursive: true, force: true }) })
  const stop = () => orchestrator.handleChatLifecycle({ kind: 'bot_removed', chatId: 'oc_synthetic' })
  return { orchestrator, runtime, registry, ...sp, space, memory, wiki, feishu, state, stop }
}

function seedWiki(t: ReturnType<typeof setup>, existing = false) {
  for (let i = 0; i < 3; i++) {
    const note = t.memory.add({ scope: `space:${t.space.id}`, kind: 'fact', title: `合成事实 ${i}`, body: `仅测试内容 ${i}` })
    expect(t.memory.confirm(note.id, `space:${t.space.id}`, { by: 'ou_owner', messageId: `om_confirmation_${i}` })).toBe(true)
  }
  if (existing) {
    t.feishu.createdDocs.push({ title: '旧合成 Wiki', markdown: '旧正文', asUser: false, documentId: 'synthetic_doc' })
    t.wiki.remember({ spaceId: t.space.id, documentId: 'synthetic_doc', url: 'https://example.invalid/wiki', title: '旧合成 Wiki' })
  }
}

describe('space stop during asynchronous lifecycle work', () => {
  it('retains the stop tombstone after a successful but late final-message ACK, without new aliases or derived memory', async () => {
    const t = setup()
    const posted = deferred()
    const releaseAck = deferred()
    const reply = t.feishu.replyMarkdown.bind(t.feishu)
    const wire = vi.spyOn(t.feishu, 'replyMarkdown').mockImplementation(async (...args) => {
      const ack = await reply(...args) // The remote side accepted the single POST before stop.
      posted.resolve()
      await releaseAck.promise
      return ack
    })
    const work = t.orchestrator.handleMessage(message())
    try {
      await posted.promise
      await t.stop()
    } finally { releaseAck.resolve() }
    await work

    expect(wire).toHaveBeenCalledTimes(1)
    expect(t.spaces.get(t.space.id)?.status).toBe('archived')
    expect(t.registry.db.prepare('SELECT status, stop_reason FROM tasks').all()).toEqual([{ status: 'cancelled', stop_reason: 'space_disabled' }])
    expect(t.registry.db.prepare('SELECT status FROM sessions').all()).toEqual([{ status: 'archived' }])
    expect(t.registry.db.prepare('SELECT COUNT(*) n FROM aliases').get()).toMatchObject({ n: 0 })
    expect(t.memory.count(`space:${t.space.id}`)).toBe(0)
    // A known remote success stays recorded; cancellation must not cause another POST.
    expect(t.registry.db.prepare('SELECT status FROM deliveries').all()).toEqual([{ status: 'sent' }])
  })

  it.each([false, true])('does not create, rewrite or grant Wiki documents when stopped during grouping (existing=%s)', async (existing) => {
    const t = setup()
    seedWiki(t, existing)
    const before = t.wiki.get(t.space.id)
    const create = vi.spyOn(t.feishu, 'createDocument')
    const rewrite = vi.spyOn(t.feishu, 'rewriteDocument')
    const grant = vi.spyOn(t.feishu, 'grantDocAccess')
    const grouping = deferred()
    const release = deferred()
    t.state.script = [{ kind: 'hook', run: async () => { grouping.resolve(); await release.promise } }, { kind: 'text', text: '[]' }]
    const work = t.orchestrator.handleMessage(message('@Friday /wiki'))
    try {
      await grouping.promise
      await t.stop()
    } finally { release.resolve() }
    await work

    expect(t.state.allPrompts).toHaveLength(1)
    expect(create).not.toHaveBeenCalled()
    expect(rewrite).not.toHaveBeenCalled()
    expect(grant).not.toHaveBeenCalled()
    expect(t.wiki.get(t.space.id)).toEqual(before)
    expect(t.registry.db.prepare('SELECT status FROM sessions').all()).toEqual([{ status: 'archived' }])
  })

  it('still creates and grants a Wiki from confirmed material while the space remains active', async () => {
    const t = setup()
    seedWiki(t)
    t.state.script = [{ kind: 'text', text: '[]' }]
    await t.orchestrator.handleMessage(message('@Friday /wiki'))
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.feishu.createdDocs).toHaveLength(1)
    expect(t.feishu.grants).toEqual([{ documentId: t.feishu.createdDocs[0]!.documentId, member: { chatId: 'oc_synthetic' }, perm: 'edit', type: 'docx' }])
    expect(t.wiki.get(t.space.id)?.revisions).toBe(1)
  })

  it('does not start a new reflection after stop while settling the completed turn reaction', async () => {
    const t = setup(true)
    const prompt = vi.spyOn(t.runtime, 'prompt')
    const settling = deferred()
    const release = deferred()
    const remove = t.feishu.removeReaction.bind(t.feishu)
    vi.spyOn(t.feishu, 'removeReaction').mockImplementation(async (...args) => {
      settling.resolve()
      await release.promise
      await remove(...args)
    })
    const work = t.orchestrator.handleMessage(message())
    try {
      await settling.promise
      await t.stop()
    } finally { release.resolve() }
    await work

    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(t.state.allPrompts).toHaveLength(1)
    expect(t.registry.db.prepare('SELECT status FROM sessions').all()).toEqual([{ status: 'archived' }])
  })

  it('still reflects after a substantive completed turn when the space remains active', async () => {
    const t = setup(true)
    const prompt = vi.spyOn(t.runtime, 'prompt')
    await t.orchestrator.handleMessage(message())
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(t.state.allPrompts).toHaveLength(2)
    expect(t.feishu.of('replyMarkdown')).toHaveLength(1)
  })
})
